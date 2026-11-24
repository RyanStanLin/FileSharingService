package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

type idleConnection struct {
	net.Conn
	armed atomic.Bool
}

func (conn *idleConnection) startIdleDeadline() {
	conn.armed.Store(true)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
}

func (conn *idleConnection) Read(buffer []byte) (int, error) {
	if conn.armed.Load() {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
	}
	return conn.Conn.Read(buffer)
}

type bridgeClient struct {
	address string
	key     string
	client  *http.Client
	relay   *http.Client
}

func newBridge(address, key string) *bridgeClient {
	return &bridgeClient{
		address: address + "/_sftp/",
		key:     key,
		client: &http.Client{
			Timeout: 35 * time.Second,
			Transport: &http.Transport{
				DialContext:         (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
				MaxConnsPerHost:     32,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     30 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		relay: &http.Client{
			Transport: &http.Transport{
				DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
				ResponseHeaderTimeout: 18 * time.Second,
				MaxConnsPerHost:       64,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (bridge *bridgeClient) call(ctx context.Context, token, operation string, input, result any) error {
	response, err := bridge.send(ctx, token, operation, input)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if result == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(result)
}

func (bridge *bridgeClient) send(ctx context.Context, token, operation string, input any) (*http.Response, error) {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, bridge.address+operation, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+bridge.key)
	if token != "" {
		request.Header.Set("X-FileSharing-SFTP-Session", token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := bridge.client.Do(request)
	if err != nil {
		return nil, errors.New("file service unavailable")
	}
	switch response.StatusCode {
	case http.StatusOK, http.StatusNoContent:
		return response, nil
	case http.StatusUnauthorized, http.StatusForbidden:
		err = os.ErrPermission
	case http.StatusNotFound:
		err = os.ErrNotExist
	default:
		err = errors.New("file request could not be completed")
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	_ = response.Body.Close()
	return nil, err
}
