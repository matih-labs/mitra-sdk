// Matih API example: Go standard library only (net/http, encoding/json, mime/multipart).
//
// Run (Go 1.21 or newer, from this directory; webhook.go is part of the same package):
//
//	export MATIH_API_KEY=mtk_...
//	go run .
//	go run . -skip-predict
//	go run . -background        (predict without Prefer: wait, start a job and poll it)
//	go run . -upload ./sales.csv
//	go run . -invite teammate@example.com -role ROLE     (admin action, never runs by default)
//	MATIH_WEBHOOK_SECRET=whsec_... go run . serve-webhook
//
// Environment:
//
//	MATIH_API_KEY       required. Create one under Settings, Integrations in Matih.
//	MATIH_BASE_URL      optional. Default https://workspace.matih.ai ("/api/v1" is appended).
//	MATIH_ON_DUPLICATE  optional. Passed as the on_duplicate form field of the file upload.
//
// Teaching example. Do not commit your API key.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type client struct {
	base string
	key  string
	http *http.Client
}

// apiError is what the API returns on failure: {"detail": {"category": "...", "message": "..."}}.
type apiError struct {
	Status   int
	Category string
	Message  string
}

func (e *apiError) Error() string {
	category := e.Category
	if category == "" {
		category = "unknown"
	}
	return fmt.Sprintf("HTTP %d [%s] %s", e.Status, category, e.Message)
}

func newAPIError(status int, data []byte) *apiError {
	e := &apiError{Status: status}
	var envelope struct {
		Detail struct {
			Category string `json:"category"`
			Message  string `json:"message"`
		} `json:"detail"`
	}
	// detail can be a list or a string for validation errors; then we fall back to the raw body.
	if json.Unmarshal(data, &envelope) == nil {
		e.Category = envelope.Detail.Category
		e.Message = envelope.Detail.Message
	}
	if e.Category == "" && e.Message == "" {
		raw := string(data)
		if len(raw) > 300 {
			raw = raw[:300]
		}
		e.Message = raw
	}
	return e
}

func retryAfter(header string) time.Duration {
	secs, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil {
		if t, perr := http.ParseTime(header); perr == nil {
			secs = int(time.Until(t).Seconds())
		} else {
			secs = 5
		}
	}
	if secs < 1 {
		secs = 1
	}
	if secs > 60 {
		secs = 60
	}
	return time.Duration(secs) * time.Second
}

// do sends one request without a Prefer header and ignores the status code.
func (c *client) do(method, path string, body []byte, contentType, idempotencyKey string, out any) error {
	_, err := c.exchange(method, path, body, contentType, idempotencyKey, "", out)
	return err
}

// exchange sends one request and returns the status code of a 2xx answer.
// On a 429 it honours Retry-After once and retries with the same Idempotency-Key,
// so a credit-costing call is never charged twice.
// prefer is an optional RFC 7240 Prefer header value: "wait=30" or "respond-async".
// A 2xx body is decoded into out when out is not nil.
func (c *client) exchange(method, path string, body []byte, contentType, idempotencyKey, prefer string, out any) (int, error) {
	for attempt := 0; ; attempt++ {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, c.base+path, reader)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "Bearer "+c.key)
		req.Header.Set("Accept", "application/json")
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		if prefer != "" {
			req.Header.Set("Prefer", prefer)
		}

		resp, err := c.http.Do(req)
		if err != nil {
			return 0, err
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return 0, err
		}

		if resp.StatusCode == http.StatusTooManyRequests && attempt == 0 {
			wait := retryAfter(resp.Header.Get("Retry-After"))
			fmt.Fprintf(os.Stderr, "rate limited (429), waiting %s and retrying once\n", wait)
			time.Sleep(wait)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return resp.StatusCode, newAPIError(resp.StatusCode, data)
		}
		if out != nil && len(data) > 0 {
			return resp.StatusCode, json.Unmarshal(data, out)
		}
		return resp.StatusCode, nil
	}
}

func (c *client) getJSON(path string, out any) error {
	return c.do(http.MethodGet, path, nil, "", "", out)
}

func (c *client) postJSON(path string, in any, idempotencyKey string, out any) error {
	var body []byte
	contentType := ""
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = encoded
		contentType = "application/json"
	}
	return c.do(http.MethodPost, path, body, contentType, idempotencyKey, out)
}

func newIdempotencyKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Job is the shape of every async job: {id, kind, state, result, error, ...}.
type job struct {
	ID     string         `json:"id"`
	Kind   string         `json:"kind"`
	State  string         `json:"state"`
	Result map[string]any `json:"result"`
	Error  *jobError      `json:"error"`
}

type jobError struct {
	Category string `json:"category"`
	Message  string `json:"message"`
}

// waitForJob polls GET /jobs/{id} until the job is succeeded, failed or cancelled.
// The delay starts at first and grows by 1.5x up to maxDelay.
func (c *client) waitForJob(id string, first, maxDelay, timeout time.Duration) (*job, error) {
	deadline := time.Now().Add(timeout)
	delay := first
	for {
		var j job
		if err := c.getJSON("/jobs/"+url.PathEscape(id), &j); err != nil {
			return nil, err
		}
		fmt.Printf("  job %s: %s\n", id, j.State)
		switch j.State {
		case "succeeded", "failed", "cancelled":
			return &j, nil
		}
		if time.Now().Add(delay).After(deadline) {
			return nil, fmt.Errorf("timed out waiting for job %s (last state %s)", id, j.State)
		}
		time.Sleep(delay)
		delay = delay * 3 / 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

// requireSucceeded returns the job result, or an error carrying error.category and error.message.
func requireSucceeded(j *job) (map[string]any, error) {
	if j.State != "succeeded" {
		category, message := "-", ""
		if j.Error != nil {
			category, message = j.Error.Category, j.Error.Message
		}
		return nil, fmt.Errorf("job %s %s: [%s] %s", j.ID, j.State, category, message)
	}
	return j.Result, nil
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func printJSON(v any) {
	encoded, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Println(v)
		return
	}
	fmt.Println(string(encoded))
}

// ---------------------------------------------------------------------------
// (1) Ask a question
// ---------------------------------------------------------------------------

type answer struct {
	Status        string `json:"status"`
	Answer        string `json:"answer"`
	Clarification *struct {
		Question string `json:"question"`
		Options  []any  `json:"options"`
	} `json:"clarification"`
	Result *struct {
		RowCount int `json:"row_count"`
	} `json:"result"`
	FollowUps      []string `json:"follow_ups"`
	ConversationID string   `json:"conversation_id"`
	Language       string   `json:"language"`
}

// ask costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
// question and reuse the same key only when retrying that exact request.
// The answer has a conversation_id: pass it back as conversationID (the
// conversation_id body field) to ask a follow-up in the same conversation.
func (c *client) ask(question, conversationID string) (string, error) {
	body := map[string]any{"question": question}
	if conversationID != "" {
		body["conversation_id"] = conversationID
	}
	var a answer
	if err := c.postJSON("/ask", body, newIdempotencyKey(), &a); err != nil {
		return "", err
	}
	fmt.Printf("status: %s\n", a.Status)
	fmt.Printf("answer: %s\n", a.Answer)
	if a.Clarification != nil {
		options, _ := json.Marshal(a.Clarification.Options)
		fmt.Printf("clarification: %s %s\n", a.Clarification.Question, options)
	}
	if a.Result != nil {
		fmt.Printf("rows: %d\n", a.Result.RowCount)
	}
	fmt.Printf("conversation_id: %s (pass it back to continue this conversation)\n", a.ConversationID)
	return a.ConversationID, nil
}

// ---------------------------------------------------------------------------
// (2) List Gems
// ---------------------------------------------------------------------------

func (c *client) listGems() error {
	var out struct {
		State string `json:"state"`
		Gems  []struct {
			ID       string `json:"id"`
			Kind     string `json:"kind"`
			Headline string `json:"headline"`
		} `json:"gems"`
	}
	if err := c.getJSON("/gems", &out); err != nil {
		return err
	}
	fmt.Printf("state: %s, %d gem(s)\n", out.State, len(out.Gems))
	for _, g := range out.Gems {
		fmt.Printf("  %s  %s  %s\n", g.ID, g.Kind, g.Headline)
	}
	return nil
}

// ---------------------------------------------------------------------------
// (1b) Ask in the background (Prefer: respond-async)
// ---------------------------------------------------------------------------

// askAsync: with "Prefer: respond-async" POST /ask returns 202 at once with a Job of kind
// "ask". Poll GET /jobs/{id}; when it succeeds the job's result is the same Answer that the
// synchronous call returns.
func (c *client) askAsync(question string) error {
	body, err := json.Marshal(map[string]any{"question": question})
	if err != nil {
		return err
	}
	var started job
	status, err := c.exchange(http.MethodPost, "/ask", body, "application/json", newIdempotencyKey(),
		"respond-async", &started)
	if err != nil {
		return err
	}
	fmt.Printf("POST /ask answered %d, job %s (kind %s)\n", status, started.ID, started.Kind)
	done, err := c.waitForJob(started.ID, time.Second, 8*time.Second, 5*time.Minute)
	if err != nil {
		return err
	}
	result, err := requireSucceeded(done)
	if err != nil {
		return err
	}
	fmt.Printf("status: %s\n", str(result, "status"))
	fmt.Printf("answer: %s\n", str(result, "answer"))
	fmt.Printf("conversation_id: %s\n", str(result, "conversation_id"))
	return nil
}

// ---------------------------------------------------------------------------
// Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds)
// ---------------------------------------------------------------------------

const waitSeconds = 30

// runWithWait works on POST /gems/generate, /predictions and /dashboards/{id}/image. The
// server answers 200 or 201 when the work finished within N seconds, otherwise 202 with a
// Job. Either way it returns the result object; on 202 it falls back to polling the job.
// If a finished answer carries a Job (it has a "state"), its result field is used.
func (c *client) runWithWait(path string, in any, idempotencyKey string,
	pollFirst, pollMax, pollTimeout time.Duration) (map[string]any, error) {
	var body []byte
	contentType := ""
	if in != nil {
		encoded, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		body = encoded
		contentType = "application/json"
	}
	var raw map[string]any
	status, err := c.exchange(http.MethodPost, path, body, contentType, idempotencyKey,
		fmt.Sprintf("wait=%d", waitSeconds), &raw)
	if err != nil {
		return nil, err
	}
	if status == http.StatusAccepted {
		id := str(raw, "id")
		fmt.Printf("  not finished within %ds (202), polling job %s\n", waitSeconds, id)
		done, err := c.waitForJob(id, pollFirst, pollMax, pollTimeout)
		if err != nil {
			return nil, err
		}
		return requireSucceeded(done)
	}
	fmt.Printf("  finished within %ds (%d)\n", waitSeconds, status)
	if state := str(raw, "state"); state != "" {
		if state != "succeeded" {
			return nil, fmt.Errorf("job %s %s", str(raw, "id"), state)
		}
		result, _ := raw["result"].(map[string]any)
		return result, nil
	}
	return raw, nil
}

// ---------------------------------------------------------------------------
// (3) Dashboard image job
// ---------------------------------------------------------------------------

// dashboardImage lists dashboards and renders the first one, sync-with-fallback: wait=N,
// and if the job is still running, poll GET /jobs/{id} with a growing delay.
// image_url is a signed URL valid for about 15 minutes that needs no Authorization header.
func (c *client) dashboardImage() error {
	var list struct {
		Dashboards []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"dashboards"`
	}
	if err := c.getJSON("/dashboards", &list); err != nil {
		return err
	}
	if len(list.Dashboards) == 0 {
		fmt.Println("no dashboards in this workspace")
		return nil
	}
	d := list.Dashboards[0]
	fmt.Printf("dashboard: %s %s\n", d.ID, d.Title)

	result, err := c.runWithWait("/dashboards/"+url.PathEscape(d.ID)+"/image", nil, "",
		time.Second, 8*time.Second, 5*time.Minute)
	if err != nil {
		return err
	}
	fmt.Printf("image_url: %s (%vx%v)\n", str(result, "image_url"), result["width"], result["height"])
	return nil
}

// ---------------------------------------------------------------------------
// (4) Predict
// ---------------------------------------------------------------------------

// A prediction can run for up to 30 minutes. Poll every 5 to 10 seconds.
// Webhooks (prediction.completed) avoid polling.

// predict is sync-with-fallback: wait=N, then poll on 202.
func (c *client) predict(question string) error {
	result, err := c.runWithWait("/predictions", map[string]any{"question": question}, newIdempotencyKey(),
		5*time.Second, 10*time.Second, 31*time.Minute)
	if err != nil {
		return err
	}
	printPrediction(result)
	return nil
}

// predictBackground is the background variant: no Prefer header. POST /predictions
// returns 202 with a Job straight away. Keep the job id (store it, hand it to another
// process) and poll GET /jobs/{id} whenever you like; here we poll right after for the demo.
func (c *client) predictBackground(question string) error {
	var started job
	body := map[string]any{"question": question}
	if err := c.postJSON("/predictions", body, newIdempotencyKey(), &started); err != nil {
		return err
	}
	fmt.Printf("started job %s; poll GET /jobs/%s later\n", started.ID, started.ID)
	done, err := c.waitForJob(started.ID, 5*time.Second, 10*time.Second, 31*time.Minute)
	if err != nil {
		return err
	}
	result, err := requireSucceeded(done)
	if err != nil {
		return err
	}
	printPrediction(result)
	return nil
}

func printPrediction(result map[string]any) {
	fmt.Printf("answer: %s\n", str(result, "answer"))
	if attachments, ok := result["attachments"].([]any); ok {
		for _, item := range attachments {
			if m, ok := item.(map[string]any); ok {
				fmt.Printf("  attachment: %s\n", str(m, "type"))
			}
		}
	}
	if img := str(result, "image_url"); img != "" {
		fmt.Printf("image_url: %s\n", img)
	}
}

// ---------------------------------------------------------------------------
// (5) List sources
// ---------------------------------------------------------------------------

func (c *client) listSources() error {
	var out struct {
		Sources []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Type   string `json:"type"`
			Status string `json:"status"`
			Active bool   `json:"active"`
		} `json:"sources"`
	}
	if err := c.getJSON("/sources", &out); err != nil {
		return err
	}
	for _, s := range out.Sources {
		fmt.Printf("  %s  %s  type=%s  status=%s  active=%t\n", s.ID, s.Name, s.Type, s.Status, s.Active)
	}
	if len(out.Sources) == 0 {
		fmt.Println("no sources yet")
	}
	return nil
}

// ---------------------------------------------------------------------------
// (6) Upload a CSV or Excel file (multipart, field name "file")
// ---------------------------------------------------------------------------

var quoteEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

func contentTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		return "text/csv"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".xls":
		return "application/vnd.ms-excel"
	}
	return "application/octet-stream"
}

// uploadFile needs the files:write scope. The optional on_duplicate field says what
// to do when the same file was uploaded before.
func (c *client) uploadFile(path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if v := os.Getenv("MATIH_ON_DUPLICATE"); v != "" {
		if err := mw.WriteField("on_duplicate", v); err != nil {
			return err
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition",
		fmt.Sprintf(`form-data; name="file"; filename="%s"`, quoteEscaper.Replace(filepath.Base(path))))
	header.Set("Content-Type", contentTypeFor(path))
	part, err := mw.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err := part.Write(content); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	var file map[string]any
	if err := c.do(http.MethodPost, "/files", buf.Bytes(), mw.FormDataContentType(), "", &file); err != nil {
		return err
	}
	fmt.Printf("uploaded: %s status=%s\n", str(file, "id"), str(file, "status"))

	// Processing is asynchronous. Needs the files:read scope to follow it.
	id := str(file, "id")
	for i := 0; i < 40 && str(file, "status") == "processing"; i++ {
		time.Sleep(3 * time.Second)
		var latest map[string]any
		if err := c.getJSON("/files/"+url.PathEscape(id), &latest); err != nil {
			return err
		}
		file = latest
		fmt.Printf("  status=%s\n", str(file, "status"))
	}
	printJSON(file)
	if file["decision_required"] == true {
		fmt.Println("the file needs a decision (duplicate handling); see POST /files/{id}/duplicate")
	}
	return nil
}

// ---------------------------------------------------------------------------
// (7) Invite a member (admin action, members:manage)
// ---------------------------------------------------------------------------

// inviteMember only runs when you pass -invite. Valid role values come from GET /members.
func (c *client) inviteMember(target, role string) error {
	key := "phone"
	if strings.Contains(target, "@") {
		key = "email"
	}
	var out map[string]any
	if err := c.postJSON("/invitations", map[string]any{key: target, "role": role}, "", &out); err != nil {
		return err
	}
	printJSON(out)
	return nil
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(2)
}

func baseURL() string {
	raw := os.Getenv("MATIH_BASE_URL")
	if raw == "" {
		raw = "https://workspace.matih.ai"
	}
	return strings.TrimRight(raw, "/") + "/api/v1"
}

func main() {
	// webhook.go provides serveWebhook; this subcommand needs no API key.
	if len(os.Args) > 1 && os.Args[1] == "serve-webhook" {
		secret := os.Getenv("MATIH_WEBHOOK_SECRET")
		if secret == "" {
			fatal("MATIH_WEBHOOK_SECRET is required")
		}
		addr := os.Getenv("MATIH_WEBHOOK_ADDR")
		if addr == "" {
			addr = ":8080"
		}
		if err := serveWebhook(secret, addr); err != nil {
			fatal(err.Error())
		}
		return
	}

	uploadPath := flag.String("upload", "", "path of a CSV or Excel file to upload")
	inviteTarget := flag.String("invite", "", "email or phone to invite (admin action)")
	inviteRole := flag.String("role", "", "role for -invite (values come from GET /members)")
	skipPredict := flag.Bool("skip-predict", false, "skip the prediction (it can take up to 30 minutes)")
	background := flag.Bool("background", false, "predict without Prefer: wait; start a job and poll it")
	flag.Parse()

	apiKey := os.Getenv("MATIH_API_KEY")
	if apiKey == "" {
		fatal("MATIH_API_KEY is required")
	}
	if *inviteTarget != "" && *inviteRole == "" {
		fatal("-invite needs -role ROLE (valid values come from GET /members)")
	}

	c := &client{base: baseURL(), key: apiKey, http: &http.Client{Timeout: 2 * time.Minute}}
	fmt.Printf("base url: %s\n", c.base)

	failures := 0
	step := func(name string, fn func() error) {
		fmt.Printf("\n== %s ==\n", name)
		if err := fn(); err != nil {
			failures++
			fmt.Fprintf(os.Stderr, "failed: %v\n", err)
		}
	}

	step("ask", func() error {
		_, err := c.ask("What were total sales last month?", "")
		return err
	})
	step("ask in the background (respond-async)", func() error {
		return c.askAsync("How many orders came in last week?")
	})
	step("gems", c.listGems)
	step("dashboard image (wait=30, falls back to polling)", c.dashboardImage)
	if !*skipPredict {
		question := "Forecast next quarter's revenue."
		if *background {
			step("predict, background variant", func() error { return c.predictBackground(question) })
		} else {
			step("predict (wait=30, falls back to polling)", func() error { return c.predict(question) })
		}
	}
	step("sources", c.listSources)
	if *uploadPath != "" {
		step("upload file", func() error { return c.uploadFile(*uploadPath) })
	}
	if *inviteTarget != "" {
		step("invite member", func() error { return c.inviteMember(*inviteTarget, *inviteRole) })
	}

	if failures > 0 {
		os.Exit(1)
	}
}
