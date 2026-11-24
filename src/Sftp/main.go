package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	origin, err := url.Parse(os.Getenv("FILESHARING_SFTP_BRIDGE"))
	if err != nil || origin.Scheme != "http" || origin.Hostname() != "127.0.0.1" ||
		origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return errors.New("a loopback SFTP bridge URL is required")
	}
	token := os.Getenv("FILESHARING_SFTP_TOKEN")
	if len(token) != 43 {
		return errors.New("an SFTP bridge token is required")
	}
	bridge := newBridge(origin.String(), token)
	defer bridge.client.CloseIdleConnections()
	key, err := hostKey(os.Getenv("FILESHARING_SFTP_KEY"))
	if err != nil {
		return fmt.Errorf("load SFTP host key: %w", err)
	}
	listener, err := net.Listen("tcp", os.Getenv("FILESHARING_SFTP_LISTEN"))
	if err != nil {
		return fmt.Errorf("listen for SFTP: %w", err)
	}
	defer listener.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		// The ASP.NET Core parent owns the other end of this pipe.
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	defer context.AfterFunc(ctx, func() { _ = listener.Close() })()
	if err := bridge.call(ctx, "", "online", map[string]string{"fingerprint": ssh.FingerprintSHA256(key.PublicKey())}, nil); err != nil {
		return fmt.Errorf("publish SFTP readiness: %w", err)
	}
	log.Printf("SFTP listening on %s", listener.Addr())

	algorithms := ssh.SupportedAlgorithms()
	config := ssh.ServerConfig{
		Config: ssh.Config{
			KeyExchanges: algorithms.KeyExchanges,
			Ciphers:      algorithms.Ciphers,
			MACs:         algorithms.MACs,
		},
		MaxAuthTries:  4,
		ServerVersion: "SSH-2.0-FileSharing",
	}
	config.AddHostKey(key)
	slots := make(chan struct{}, 64)
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			stop()
			return err
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() { <-slots }()
				serve(ctx, conn, config, bridge)
			}()
		default:
			_ = conn.Close()
		}
	}
}

func serve(ctx context.Context, raw net.Conn, config ssh.ServerConfig, bridge *bridgeClient) {
	defer raw.Close()
	connection := &idleConnection{Conn: raw}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer context.AfterFunc(ctx, func() { _ = raw.Close() })()
	var session string
	defer func() {
		if session != "" {
			cleanup, stop := context.WithTimeout(context.Background(), 2*time.Second)
			defer stop()
			_ = bridge.call(cleanup, session, "close", nil, nil)
		}
	}()
	config.PasswordCallback = func(peer ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		var response struct{ Token string }
		address, _, _ := net.SplitHostPort(peer.RemoteAddr().String())
		attempt := struct {
			Name     string `json:"name"`
			Password string `json:"password"`
			Peer     string `json:"peer"`
		}{peer.User(), string(password), address}
		auth, stop := context.WithTimeout(ctx, 6*time.Second)
		defer stop()
		err := bridge.call(auth, "", "open", attempt, &response)
		if err != nil || len(response.Token) != 43 {
			return nil, errors.New("authentication failed")
		}
		session = response.Token
		return nil, nil
	}
	_ = raw.SetDeadline(time.Now().Add(12 * time.Second))
	server, channels, requests, err := ssh.NewServerConn(connection, &config)
	if err != nil {
		return
	}
	defer server.Close()
	_ = raw.SetDeadline(time.Time{})
	connection.startIdleDeadline()
	go ssh.DiscardRequests(requests)
	go renewSession(ctx, raw, bridge, session)

	used := false
	for channel := range channels {
		if used || channel.ChannelType() != "session" {
			_ = channel.Reject(ssh.Prohibited, "SFTP session only")
			continue
		}
		stream, inbound, err := channel.Accept()
		if err != nil {
			return
		}
		used = true
		go func() {
			defer raw.Close()
			defer stream.Close()
			for request := range inbound {
				var subsystem struct{ Name string }
				allowed := request.Type == "subsystem" && ssh.Unmarshal(request.Payload, &subsystem) == nil && subsystem.Name == "sftp"
				_ = request.Reply(allowed, nil)
				if allowed {
					go ssh.DiscardRequests(inbound)
					handler := &remoteFS{bridge: bridge, token: session, handles: make(chan struct{}, 32)}
					service := sftp.NewRequestServer(stream, sftp.Handlers{FileGet: handler, FilePut: handler, FileCmd: handler, FileList: handler})
					defer service.Close()
					var status uint32
					if err := service.Serve(); err != nil && !errors.Is(err, io.EOF) {
						status = 1
					}
					_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
					return
				}
			}
		}()
	}
}

func renewSession(ctx context.Context, raw net.Conn, bridge *bridgeClient, session string) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check, stop := context.WithTimeout(ctx, 4*time.Second)
			err := bridge.call(check, session, "active", nil, nil)
			stop()
			if err != nil {
				_ = raw.Close()
				return
			}
		}
	}
}

func hostKey(path string) (ssh.Signer, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("absolute host key path required")
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 16_384 {
			return nil, errors.New("host key file must be a private regular file")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return ssh.ParsePrivateKey(content)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(privateKey, "FileSharing")
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".ssh-key-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := pem.Encode(file, block); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	if err := os.Link(file.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return hostKey(path)
		}
		return nil, err
	}
	return ssh.NewSignerFromKey(privateKey)
}
