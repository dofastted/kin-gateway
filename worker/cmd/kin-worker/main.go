package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
	kinoauth "github.com/dofastted/kin-gateway/worker/internal/oauth"
	kinserver "github.com/dofastted/kin-gateway/worker/internal/server"
	"github.com/dofastted/kin-gateway/worker/internal/upstream"
)

func main() {
	configPath := flag.String("config", "", "path to worker JSON config")
	flag.Parse()

	var cfg config.Config
	var err error
	if *configPath != "" {
		cfg, err = config.Load(*configPath)
	} else {
		cfg, err = config.FromEnv()
	}
	if err != nil {
		log.Fatalf("load worker config: %v", err)
	}
	httpClient, err := upstream.NewHTTPClient(cfg.ProxyURL, cfg.ProxyRequired, cfg.RequestTimeout)
	if err != nil {
		log.Fatalf("create slot HTTP client: %v", err)
	}
	baseURL, err := url.Parse(cfg.AnthropicBaseURL)
	if err != nil {
		log.Fatalf("parse Anthropic base URL: %v", err)
	}
	store := credential.NewStore(cfg.CredentialPath)
	refresher := &kinoauth.Refresher{
		Store:    store,
		Client:   httpClient,
		TokenURL: cfg.OAuthTokenURL,
		ClientID: kinoauth.DefaultClientID,
		Skew:     cfg.RefreshSkew,
		MaxTries: 3,
	}
	upstreamClient := &upstream.Client{
		HTTP:           httpClient,
		Store:          store,
		Refresher:      refresher,
		AnthropicBase:  baseURL,
		RequestTimeout: cfg.RequestTimeout,
	}
	worker := &kinserver.Server{
		Config:    cfg,
		Store:     store,
		Refresher: refresher,
		Upstream:  upstreamClient,
	}

	if err = os.MkdirAll(filepath.Dir(cfg.SocketPath), 0o770); err != nil {
		log.Fatalf("create worker socket directory: %v", err)
	}
	_ = os.Remove(cfg.SocketPath)
	listener, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log.Fatalf("listen on worker socket: %v", err)
	}
	defer listener.Close()
	defer os.Remove(cfg.SocketPath)
	if err = os.Chmod(cfg.SocketPath, 0o660); err != nil {
		log.Fatalf("chmod worker socket: %v", err)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	worker.StartBackgroundRefresh(rootCtx)

	server := &http.Server{
		Handler:           worker.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
	errs := make(chan error, 1)
	go func() {
		errs <- server.Serve(listener)
	}()
	log.Printf("kin-worker ready vm=%s socket=%s proxy=configured", cfg.VMID, cfg.SocketPath)

	select {
	case <-rootCtx.Done():
	case serveErr := <-errs:
		if serveErr != nil && serveErr != http.ErrServerClosed {
			log.Fatalf("serve worker: %v", serveErr)
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err = server.Shutdown(shutdownCtx); err != nil {
		fmt.Fprintf(os.Stderr, "worker shutdown: %v\n", err)
	}
}
