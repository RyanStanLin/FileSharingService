package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

func (bridge *bridgeClient) authorizeJump(ctx context.Context) func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
	return func(peer ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		user := peer.User()
		if len(user) != 42 || !strings.HasPrefix(user, "relay-") {
			return nil, errors.New("authentication failed")
		}
		address, _, _ := net.SplitHostPort(peer.RemoteAddr().String())
		auth, stop := context.WithTimeout(ctx, 6*time.Second)
		defer stop()
		var grant struct{ ID, Destination string }
		err := bridge.call(auth, "", "ssh/authorize", map[string]string{
			"user": user, "fingerprint": ssh.FingerprintSHA256(key), "peer": address,
		}, &grant)
		if err != nil || "relay-"+grant.ID != user || grant.Destination == "" {
			return nil, errors.New("authentication failed")
		}
		return &ssh.Permissions{Extensions: map[string]string{"relay": grant.ID, "destination": grant.Destination}}, nil
	}
}

func (bridge *bridgeClient) serveJump(ctx context.Context, channels <-chan ssh.NewChannel, grant map[string]string) {
	for channel := range channels {
		var address struct {
			Host       string
			Port       uint32
			OriginHost string
			OriginPort uint32
		}
		if channel.ChannelType() != "direct-tcpip" || ssh.Unmarshal(channel.ExtraData(), &address) != nil ||
			address.Host != grant["destination"] || address.Port != 22 {
			_ = channel.Reject(ssh.Prohibited, "Use the assigned Mac and SSH port")
			continue
		}
		bridge.connectJump(ctx, channel, grant["relay"])
		return
	}
}

func (bridge *bridgeClient) connectJump(ctx context.Context, channel ssh.NewChannel, id string) {
	upstream, err := bridge.openRelay(ctx, id)
	if err != nil {
		_ = channel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	defer upstream.Close()
	stream, requests, err := channel.Accept()
	if err != nil {
		return
	}
	defer stream.Close()
	go ssh.DiscardRequests(requests)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(upstream, stream)
		_ = upstream.Close()
	}()
	_, _ = io.Copy(stream, upstream)
	_ = stream.Close()
	_ = upstream.Close()
	<-done
}

func (bridge *bridgeClient) openRelay(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, bridge.address+"ssh/stream/"+id, nil)
	if err != nil {
		return nil, errors.New("SSH relay unavailable")
	}
	request.Header.Set("Authorization", "Bearer "+bridge.key)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "filesharing-ssh")
	response, err := bridge.relay.Do(request)
	if err != nil {
		return nil, errors.New("SSH relay unavailable")
	}
	if response.StatusCode == http.StatusSwitchingProtocols {
		if stream, ok := response.Body.(io.ReadWriteCloser); ok {
			return stream, nil
		}
	}
	defer response.Body.Close()
	var problem struct{ Code string }
	_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&problem)
	switch problem.Code {
	case "ssh_remote_login_unavailable":
		return nil, errors.New("Mac Remote Login is unavailable")
	case "unsupported":
		return nil, errors.New("Update the Mac Agent for SSH relay support")
	default:
		return nil, errors.New("SSH relay expired or unavailable")
	}
}
