// Matih webhook signature verification: Go standard library only.
//
// This file is part of package main next to main.go. Run the demo server with:
//
//	export MATIH_WEBHOOK_SECRET=whsec_...
//	go run . serve-webhook          # listens on :8080, POST /matih/webhook
//	MATIH_WEBHOOK_ADDR=:9000 go run . serve-webhook
//
// Every delivery carries three headers:
//
//	Matih-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
//	Matih-Event:     the event name, for example gems.ready
//	Matih-Delivery:  a unique delivery id, handy for de-duplicating retries
//
// Rules implemented below:
//  1. Sign the RAW request bytes, not re-serialised JSON.
//  2. Reject when |now - t| > 300 seconds (replay protection).
//  3. The header may carry several v1 values; any one matching is enough.
//  4. Compare with hmac.Equal (constant time).
//
// The whole secret string is used as the HMAC key, including the whsec_ prefix.
// Teaching example. Do not commit your webhook secret.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	webhookTolerance = 300 * time.Second
	maxWebhookBody   = 1 << 20
)

// verifyWebhook checks a Matih-Signature header against the raw body.
// now is a parameter so the check can be tested.
func verifyWebhook(secret, header string, body []byte, now time.Time) error {
	var ts string
	var candidates []string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			ts = value
		case "v1":
			candidates = append(candidates, value)
		}
	}
	if ts == "" || len(candidates) == 0 {
		return errors.New("missing or malformed Matih-Signature header")
	}
	sent, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return errors.New("malformed timestamp in Matih-Signature header")
	}
	skew := now.Unix() - sent
	if skew < 0 {
		skew = -skew
	}
	if skew > int64(webhookTolerance/time.Second) {
		return fmt.Errorf("timestamp outside the %d second tolerance", int64(webhookTolerance/time.Second))
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	expected := mac.Sum(nil)

	matched := false
	for _, candidate := range candidates {
		got, err := hex.DecodeString(candidate)
		if err != nil {
			continue
		}
		if hmac.Equal(got, expected) {
			matched = true
		}
	}
	if !matched {
		return errors.New("no matching v1 signature")
	}
	return nil
}

// webhookHandler reads the RAW body (before any JSON decoding), verifies the
// signature, and only then looks at the payload.
func webhookHandler(secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
		if err != nil {
			http.Error(w, "could not read body", http.StatusRequestEntityTooLarge)
			return
		}
		if err := verifyWebhook(secret, r.Header.Get("Matih-Signature"), body, time.Now()); err != nil {
			log.Printf("rejected delivery: %v", err)
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		log.Printf("event=%s delivery=%s bytes=%d",
			r.Header.Get("Matih-Event"), r.Header.Get("Matih-Delivery"), len(body))
		// Answer 2xx quickly and do slow work elsewhere. Retries reuse Matih-Delivery.
		w.WriteHeader(http.StatusNoContent)
	})
}

// serveWebhook runs a small HTTP server that accepts Matih deliveries.
func serveWebhook(secret, addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/matih/webhook", webhookHandler(secret))
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
	}
	log.Printf("listening on %s, POST /matih/webhook", addr)
	return srv.ListenAndServe()
}
