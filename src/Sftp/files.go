package main

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/pkg/sftp"
)

type remoteFS struct {
	bridge  *bridgeClient
	token   string
	handles chan struct{}
}

func (fs *remoteFS) reserve() (func(), error) {
	select {
	case fs.handles <- struct{}{}:
		return sync.OnceFunc(func() { <-fs.handles }), nil
	default:
		return nil, errors.New("too many open handles")
	}
}

type entry struct {
	Name       string
	Kind       string
	Size       int64
	ModifiedAt time.Time
	Mode       uint32
}

type fileInfo struct{ entry }

func (entry fileInfo) Name() string       { return entry.entry.Name }
func (entry fileInfo) Size() int64        { return entry.entry.Size }
func (entry fileInfo) ModTime() time.Time { return entry.ModifiedAt }
func (entry fileInfo) IsDir() bool        { return entry.Kind == "directory" }
func (entry fileInfo) Sys() any           { return nil }
func (entry fileInfo) Mode() os.FileMode {
	mode := os.FileMode(entry.entry.Mode & 0o555)
	switch entry.Kind {
	case "directory":
		mode |= os.ModeDir
	case "symlink":
		mode |= os.ModeSymlink
	case "file":
	default:
		mode |= os.ModeIrregular
	}
	return mode
}

func (fs *remoteFS) Filelist(req *sftp.Request) (sftp.ListerAt, error) {
	switch req.Method {
	case "Stat":
		var result entry
		err := fs.bridge.call(req.Context(), fs.token, "stat", map[string]string{"path": req.Filepath}, &result)
		if err != nil {
			return nil, err
		}
		return entries{fileInfo{result}}, nil
	case "List":
		release, err := fs.reserve()
		if err != nil {
			return nil, err
		}
		list := &directory{ctx: req.Context(), fs: fs, path: req.Filepath, release: release}
		if err := list.next(0); err != nil {
			release()
			return nil, err
		}
		return list, nil
	default:
		return nil, sftp.ErrSSHFxOpUnsupported
	}
}

type entries []os.FileInfo

func (items entries) ListAt(buffer []os.FileInfo, offset int64) (int, error) {
	if offset < 0 || offset >= int64(len(items)) {
		return 0, io.EOF
	}
	count := copy(buffer, items[offset:])
	if count < len(buffer) {
		return count, io.EOF
	}
	return count, nil
}

type volumePage struct {
	Items        []entry
	NextOffset   *int
	Revision     string
	ConnectionID *string
}

type directory struct {
	ctx     context.Context
	fs      *remoteFS
	path    string
	release func()
	mu      sync.Mutex
	start   int
	page    volumePage
}

func (dir *directory) next(offset int) error {
	var result volumePage
	err := dir.fs.bridge.call(dir.ctx, dir.fs.token, "list", map[string]any{
		"path": dir.path, "offset": offset, "revision": dir.page.Revision, "connectionId": dir.page.ConnectionID,
	}, &result)
	if err != nil {
		return err
	}
	dir.start = offset
	dir.page = result
	return nil
}

func (dir *directory) ListAt(buffer []os.FileInfo, offset int64) (int, error) {
	dir.mu.Lock()
	defer dir.mu.Unlock()
	if dir.page.NextOffset != nil && int64(*dir.page.NextOffset) == offset {
		if err := dir.next(int(offset)); err != nil {
			return 0, err
		}
	}
	index := offset - int64(dir.start)
	if index < 0 || index >= int64(len(dir.page.Items)) {
		return 0, io.EOF
	}
	count := min(len(buffer), len(dir.page.Items)-int(index))
	for i := range count {
		buffer[i] = fileInfo{dir.page.Items[int(index)+i]}
	}
	return count, nil
}

func (dir *directory) Close() error {
	dir.release()
	return nil
}

type remoteFile struct {
	ctx     context.Context
	fs      *remoteFS
	target  jsonFile
	release func()
}

type jsonFile struct {
	Address map[string]string
	Version string
	Size    int64
}

func (fs *remoteFS) Fileread(req *sftp.Request) (io.ReaderAt, error) {
	release, err := fs.reserve()
	if err != nil {
		return nil, err
	}
	var target jsonFile
	err = fs.bridge.call(req.Context(), fs.token, "file", map[string]string{"path": req.Filepath}, &target)
	if err != nil {
		release()
		return nil, err
	}
	return &remoteFile{ctx: req.Context(), fs: fs, target: target, release: release}, nil
}

func (file *remoteFile) ReadAt(buffer []byte, offset int64) (int, error) {
	if offset < 0 || len(buffer) > 262_144 {
		return 0, os.ErrInvalid
	}
	if len(buffer) == 0 {
		return 0, nil
	}
	if offset >= file.target.Size {
		return 0, io.EOF
	}
	length := min(int64(len(buffer)), file.target.Size-offset)
	response, err := file.fs.bridge.send(file.ctx, file.fs.token, "read", map[string]any{
		"address": file.target.Address, "version": file.target.Version, "offset": offset, "length": length,
	})
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.ContentLength != length {
		return 0, errors.New("invalid read response")
	}
	count, err := io.ReadFull(response.Body, buffer[:length])
	if err != nil {
		return 0, errors.New("file request was interrupted")
	}
	if count < len(buffer) {
		return count, io.EOF
	}
	return count, nil
}

func (file *remoteFile) Close() error {
	file.release()
	return nil
}

func (*remoteFS) Filewrite(*sftp.Request) (io.WriterAt, error) { return nil, os.ErrPermission }
func (*remoteFS) Filecmd(*sftp.Request) error                  { return os.ErrPermission }
