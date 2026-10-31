// Matih API example: plain Java (java.net.http). No libraries.
//
// Run (Java 11 or newer, single-file source launch):
//   export MATIH_API_KEY=mtk_...
//   java MatihExample.java
//   java MatihExample.java --skip-predict
//   java MatihExample.java --background     (predict without Prefer: wait, start a job and poll it)
//   java MatihExample.java --upload ./sales.csv
//   java MatihExample.java --invite teammate@example.com --role user   (admin action, never runs by default)
//
// Environment:
//   MATIH_API_KEY       required. Create one under Settings › API & MCP in Matih.
//   MATIH_BASE_URL      optional. Default https://workspace.matih.ai ("/api/v1" is appended).
//   MATIH_ON_DUPLICATE  optional. The on_duplicate form field of the file upload: ask (default) or keep_both.
//
// Output goes through java.util.logging (to stderr, message only), so nothing needs a library.
// JSON handling here is deliberately tiny (regex field extraction) so the file has no
// dependencies. In real code use Jackson, Gson or similar.
// Teaching example. Do not commit your API key.

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.logging.ConsoleHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MatihExample {

    private static final Logger LOG = createLogger();
    private static final String API_KEY = System.getenv("MATIH_API_KEY");
    private static final String BASE = baseUrl();
    private static final HttpClient HTTP =
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    /** A logger that prints just the message, so the output reads like plain console output. */
    private static Logger createLogger() {
        Logger logger = Logger.getLogger("matih.example");
        logger.setUseParentHandlers(false);
        logger.setLevel(Level.ALL);
        ConsoleHandler handler = new ConsoleHandler();
        handler.setLevel(Level.ALL);
        handler.setFormatter(new Formatter() {
            @Override
            public String format(LogRecord record) {
                return formatMessage(record) + System.lineSeparator();
            }
        });
        logger.addHandler(handler);
        return logger;
    }

    private static String baseUrl() {
        String raw = System.getenv("MATIH_BASE_URL");
        if (raw == null || raw.isEmpty()) {
            raw = "https://workspace.matih.ai";
        }
        while (raw.endsWith("/")) {
            raw = raw.substring(0, raw.length() - 1);
        }
        return raw + "/api/v1";
    }

    // -----------------------------------------------------------------------
    // HTTP plumbing
    // -----------------------------------------------------------------------

    /** Errors from the API look like {"detail": {"category": "...", "message": "..."}}. */
    static final class ApiException extends Exception {
        final int status;

        ApiException(int status, String body) {
            super(describe(status, body));
            this.status = status;
        }

        private static String describe(int status, String body) {
            String category = field(body, "category");
            String message = field(body, "message");
            if (category == null && message == null) {
                String shown = body.length() > 300 ? body.substring(0, 300) : body;
                return "HTTP " + status + ": " + shown;
            }
            return "HTTP " + status + " [" + category + "] " + message;
        }
    }

    /** Status code and body of a 2xx answer. */
    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /** Same as callFull but returns only the body, with no Prefer header. */
    static String call(String method, String path, byte[] body, String contentType, String idempotencyKey)
            throws IOException, InterruptedException, ApiException {
        return callFull(method, path, body, contentType, idempotencyKey, null).body;
    }

    /**
     * One request. On a 429 it honours Retry-After once and retries with the same
     * Idempotency-Key (the server honours it on /ask and /predictions).
     * prefer is an optional RFC 7240 Prefer header value: "wait=30" or "respond-async".
     * Returns status and body of a 2xx answer; throws ApiException otherwise.
     */
    static Reply callFull(String method, String path, byte[] body, String contentType, String idempotencyKey,
            String prefer) throws IOException, InterruptedException, ApiException {
        for (int attempt = 0; ; attempt++) {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(BASE + path))
                    .timeout(Duration.ofSeconds(120))
                    .header("Authorization", "Bearer " + API_KEY)
                    .header("Accept", "application/json");
            if (contentType != null) {
                builder.header("Content-Type", contentType);
            }
            if (idempotencyKey != null) {
                builder.header("Idempotency-Key", idempotencyKey);
            }
            if (prefer != null) {
                builder.header("Prefer", prefer);
            }
            builder.method(
                    method,
                    body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(body));

            HttpResponse<String> response = HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();

            if (status == 429 && attempt == 0) {
                long wait = retryAfterSeconds(response.headers().firstValue("Retry-After").orElse(null));
                LOG.warning("rate limited (429), waiting " + wait + "s and retrying once");
                Thread.sleep(wait * 1000);
                continue;
            }
            if (status >= 200 && status < 300) {
                return new Reply(status, response.body());
            }
            throw new ApiException(status, response.body());
        }
    }

    private static long retryAfterSeconds(String header) {
        if (header == null) {
            return 5;
        }
        try {
            return Math.max(1, Math.min(60, Long.parseLong(header.trim())));
        } catch (NumberFormatException e) {
            return 5; // an HTTP date; fall back to a fixed wait
        }
    }

    private static String get(String path) throws IOException, InterruptedException, ApiException {
        return call("GET", path, null, null, null);
    }

    private static String postJson(String path, String json, String idempotencyKey)
            throws IOException, InterruptedException, ApiException {
        return call("POST", path, json.getBytes(StandardCharsets.UTF_8), "application/json", idempotencyKey);
    }

    /**
     * Poll GET /jobs/{id} until the job is succeeded, failed or cancelled.
     * The delay starts at firstDelayMs and grows by 1.5x up to maxDelayMs.
     * Returns the final job JSON.
     */
    static String waitForJob(String jobId, long firstDelayMs, long maxDelayMs, long timeoutMs)
            throws IOException, InterruptedException, ApiException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        long delay = firstDelayMs;
        while (true) {
            String job = get("/jobs/" + jobId);
            String state = field(job, "state");
            LOG.info("  job " + jobId + ": " + state);
            if (state == null) {
                throw new IOException("unexpected job response: " + job);
            }
            if (state.equals("succeeded") || state.equals("failed") || state.equals("cancelled")) {
                return job;
            }
            if (System.currentTimeMillis() + delay > deadline) {
                throw new IOException("timed out waiting for job " + jobId + " (last state " + state + ")");
            }
            Thread.sleep(delay);
            delay = Math.min(maxDelayMs, delay * 3 / 2);
        }
    }

    /** Throws unless the job succeeded; a failed job carries error.category and error.message. */
    private static void requireSucceeded(String job) throws IOException {
        String state = field(job, "state");
        if (!"succeeded".equals(state)) {
            throw new IOException("job " + state + ": [" + field(job, "category") + "] " + field(job, "message"));
        }
    }

    // -----------------------------------------------------------------------
    // (1) Ask a question
    // -----------------------------------------------------------------------
    // Costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
    // question and reuse the same key only when retrying that exact request.
    // The answer has a conversation_id: pass it back as conversationId (the
    // conversation_id body field) to ask a follow-up in the same conversation.
    static String ask(String question, String conversationId)
            throws IOException, InterruptedException, ApiException {
        String body = "{\"question\":" + quote(question)
                + (conversationId != null ? ",\"conversation_id\":" + quote(conversationId) : "")
                + "}";
        String answer = postJson("/ask", body, UUID.randomUUID().toString());
        String status = field(answer, "status");
        LOG.info("status: " + status);
        LOG.info("answer: " + field(answer, "answer"));
        if ("clarification".equals(status)) {
            LOG.info("clarification: " + field(answer, "question"));
        }
        String conversation = field(answer, "conversation_id");
        LOG.info("conversation_id: " + conversation + " (pass it back to continue this conversation)");
        return conversation;
    }

    // -----------------------------------------------------------------------
    // (2) List Gems
    // -----------------------------------------------------------------------
    static void listGems() throws IOException, InterruptedException, ApiException {
        String body = get("/gems");
        LOG.info("state: " + field(body, "state"));
        List<String> headlines = fields(body, "headline");
        for (String headline : headlines) {
            LOG.info("  " + headline);
        }
        LOG.info(headlines.size() + " gem(s)");
    }

    // -----------------------------------------------------------------------
    // (1b) Ask in the background (Prefer: respond-async)
    // -----------------------------------------------------------------------
    // With "Prefer: respond-async" POST /ask returns 202 at once with a Job of kind "ask".
    // Poll GET /jobs/{id}; when it succeeds the job's result is the same Answer that the
    // synchronous call returns.
    static void askAsync(String question) throws IOException, InterruptedException, ApiException {
        Reply started = callFull("POST", "/ask",
                ("{\"question\":" + quote(question) + "}").getBytes(StandardCharsets.UTF_8),
                "application/json", UUID.randomUUID().toString(), "respond-async");
        String jobId = field(started.body, "id");
        LOG.info("POST /ask answered " + started.status + ", job " + jobId + " (kind " + field(started.body, "kind") + ")");
        String job = waitForJob(jobId, 1000, 8000, 5 * 60 * 1000L);
        requireSucceeded(job);
        LOG.info("answer: " + field(job, "answer"));
        LOG.info("conversation_id: " + field(job, "conversation_id"));
    }

    // -----------------------------------------------------------------------
    // Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds)
    // -----------------------------------------------------------------------
    // Works on POST /gems/generate, /predictions and /dashboards/{id}/image. The server
    // answers 200 or 201 when the work finished within N seconds, otherwise 202 with a Job.
    // Either way this returns JSON holding the result fields; on 202 it falls back to
    // polling the job. If a finished answer carries a Job (it has a "state"), it must have
    // succeeded.
    private static final int WAIT_SECONDS = 30;

    static String runWithWait(String path, byte[] body, String contentType, String idempotencyKey,
            long firstDelayMs, long maxDelayMs, long timeoutMs)
            throws IOException, InterruptedException, ApiException {
        Reply reply = callFull("POST", path, body, contentType, idempotencyKey, "wait=" + WAIT_SECONDS);
        if (reply.status == 202) {
            LOG.info("  not finished within " + WAIT_SECONDS + "s (202), polling job " + field(reply.body, "id"));
            String job = waitForJob(field(reply.body, "id"), firstDelayMs, maxDelayMs, timeoutMs);
            requireSucceeded(job);
            return job;
        }
        LOG.info("  finished within " + WAIT_SECONDS + "s (" + reply.status + ")");
        if (field(reply.body, "state") != null) {
            requireSucceeded(reply.body);
        }
        return reply.body;
    }

    // -----------------------------------------------------------------------
    // (3) Dashboard image job
    // -----------------------------------------------------------------------
    // Sync-with-fallback: wait=N, and if the job is still running, poll GET /jobs/{id}
    // with a growing delay. image_url is a public, unguessable URL that expires after
    // 15 minutes and needs no Authorization header.
    static void dashboardImage() throws IOException, InterruptedException, ApiException {
        String dashboards = get("/dashboards");
        String dashboardId = field(dashboards, "id"); // first dashboard in the list
        if (dashboardId == null) {
            LOG.info("no dashboards in this workspace");
            return;
        }
        LOG.info("dashboard: " + dashboardId + " " + field(dashboards, "title"));
        String result = runWithWait("/dashboards/" + dashboardId + "/image", null, null, null,
                1000, 8000, 5 * 60 * 1000L);
        LOG.info("image_url: " + field(result, "image_url"));
    }

    // -----------------------------------------------------------------------
    // (4) Predict
    // -----------------------------------------------------------------------
    // A prediction usually takes one to five minutes; the server gives up after 30.
    // Poll every 5 to 10 seconds. Webhooks (prediction.completed) avoid polling.
    // A finished prediction's result is {conversation_id, answer}; answer is a string.
    private static void printPrediction(String result) {
        LOG.info("answer: " + field(result, "answer"));
        LOG.info("conversation_id: " + field(result, "conversation_id")
                + " (pass it to POST /predictions to continue)");
    }

    /** Sync-with-fallback: wait=N, then poll on 202. */
    static void predict(String question) throws IOException, InterruptedException, ApiException {
        String result = runWithWait("/predictions",
                ("{\"question\":" + quote(question) + "}").getBytes(StandardCharsets.UTF_8),
                "application/json", UUID.randomUUID().toString(), 5000, 10000, 31 * 60 * 1000L);
        printPrediction(result);
    }

    /**
     * Background variant: no Prefer header. POST /predictions returns 202 with a Job straight
     * away. Keep the job id (store it, hand it to another process) and poll GET /jobs/{id}
     * whenever you like; here we poll right after for the demo.
     */
    static void predictBackground(String question) throws IOException, InterruptedException, ApiException {
        String started = postJson("/predictions", "{\"question\":" + quote(question) + "}",
                UUID.randomUUID().toString());
        String jobId = field(started, "id");
        LOG.info("started job " + jobId + "; poll GET /jobs/" + jobId + " later");
        String job = waitForJob(jobId, 5000, 10000, 31 * 60 * 1000L);
        requireSucceeded(job);
        printPrediction(job);
    }

    // -----------------------------------------------------------------------
    // (5) List sources
    // -----------------------------------------------------------------------
    static void listSources() throws IOException, InterruptedException, ApiException {
        String body = get("/sources");
        List<String> ids = fields(body, "id");
        List<String> names = fields(body, "name");
        List<String> types = fields(body, "connector_type");
        List<String> states = fields(body, "state");
        List<String> active = fields(body, "is_active");
        for (int i = 0; i < ids.size(); i++) {
            LOG.info("  " + ids.get(i) + "  " + at(names, i) + "  connector_type=" + at(types, i)
                    + "  state=" + at(states, i) + "  active=" + at(active, i));
        }
        if (ids.isEmpty()) {
            LOG.info("no sources yet");
        }
    }

    // -----------------------------------------------------------------------
    // (6) Upload a CSV or Excel file (multipart, field name "file")
    // -----------------------------------------------------------------------
    // Needs the files:write scope. The optional on_duplicate field is "ask" (the default:
    // an identical file waits for a decision) or "keep_both". The multipart body is built by hand.
    static void uploadFile(String pathArg) throws IOException, InterruptedException, ApiException {
        Path path = Paths.get(pathArg);
        byte[] content = Files.readAllBytes(path);
        String filename = path.getFileName().toString().replace("\"", "%22");
        String boundary = "----matih" + UUID.randomUUID().toString().replace("-", "");

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        String onDuplicate = System.getenv("MATIH_ON_DUPLICATE");
        if (onDuplicate != null && !onDuplicate.isEmpty()) {
            write(out, "--" + boundary + "\r\n"
                    + "Content-Disposition: form-data; name=\"on_duplicate\"\r\n\r\n"
                    + onDuplicate + "\r\n");
        }
        write(out, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\n"
                + "Content-Type: " + contentTypeFor(filename) + "\r\n\r\n");
        out.write(content);
        write(out, "\r\n--" + boundary + "--\r\n");

        // A file is a File, not a Job. "Prefer: wait=30" (up to 120) holds the request until
        // it is ready; if processing is still running the answer is 202.
        String uploaded = callFull("POST", "/files", out.toByteArray(),
                "multipart/form-data; boundary=" + boundary, null, "wait=30").body;
        String id = field(uploaded, "id");
        LOG.info("uploaded: " + id + " status=" + field(uploaded, "status") + " ready=" + field(uploaded, "ready"));

        // Follow it with GET /files/{id} (needs files:read) until Ask can use it, it needs
        // attention or failed, or it waits for a duplicate decision.
        String latest = uploaded;
        for (int i = 0; i < 40 && !fileSettled(latest); i++) {
            Thread.sleep(3000);
            latest = get("/files/" + id);
            LOG.info("  status=" + field(latest, "status") + " ready=" + field(latest, "ready"));
        }
        LOG.info(latest);
        if ("true".equals(field(latest, "decision_required"))) {
            LOG.info("the file is a duplicate and waits for a decision (see decision_options above:"
                    + " use_existing, keep_both or cancel); send it to POST /files/{id}/duplicate");
        }
    }

    private static boolean fileSettled(String file) {
        String status = field(file, "status");
        return "true".equals(field(file, "ready")) || "true".equals(field(file, "decision_required"))
                || "needs_attention".equals(status) || "failed".equals(status);
    }

    private static String contentTypeFor(String filename) {
        String lower = filename.toLowerCase();
        if (lower.endsWith(".csv")) {
            return "text/csv";
        }
        if (lower.endsWith(".xlsx")) {
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        }
        if (lower.endsWith(".xls")) {
            return "application/vnd.ms-excel";
        }
        return "application/octet-stream";
    }

    private static void write(ByteArrayOutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.UTF_8));
    }

    // -----------------------------------------------------------------------
    // (7) Invite a member (admin action, members:manage)
    // -----------------------------------------------------------------------
    // Only runs when you pass --invite. role is viewer, user or admin (never owner).
    static void inviteMember(String target, String role) throws IOException, InterruptedException, ApiException {
        String key = target.contains("@") ? "email" : "phone";
        String body = "{\"" + key + "\":" + quote(target) + ",\"role\":" + quote(role) + "}";
        LOG.info(postJson("/invitations", body, null));
    }

    // -----------------------------------------------------------------------
    // Tiny JSON helpers
    // -----------------------------------------------------------------------

    /** JSON string literal with escaping. */
    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append('"').toString();
    }

    /** Every value of "key": ... in the document, in order. null values are skipped. */
    static List<String> fields(String json, String key) {
        List<String> found = new ArrayList<>();
        if (json == null) {
            return found;
        }
        Pattern pattern = Pattern.compile(
                "\"" + Pattern.quote(key) + "\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^,}\\]\\s]+))");
        Matcher m = pattern.matcher(json);
        while (m.find()) {
            if (m.group(1) != null) {
                found.add(unescape(m.group(1)));
            } else if (!m.group(2).equals("null")) {
                found.add(m.group(2));
            }
        }
        return found;
    }

    /** First value of "key": ... in the document, or null. */
    static String field(String json, String key) {
        List<String> all = fields(json, key);
        return all.isEmpty() ? null : all.get(0);
    }

    private static String at(List<String> list, int i) {
        return i < list.size() ? list.get(i) : "-";
    }

    private static String unescape(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) {
                sb.append(c);
                continue;
            }
            char n = s.charAt(++i);
            switch (n) {
                case 'n':
                    sb.append('\n');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case 'u':
                    if (i + 4 < s.length()) {
                        sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                        i += 4;
                    }
                    break;
                default:
                    sb.append(n); // \" \\ \/
            }
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // main
    // -----------------------------------------------------------------------

    interface Step {
        void run() throws Exception;
    }

    private static int failures = 0;

    private static void runStep(String name, Step step) {
        LOG.info("\n== " + name + " ==");
        try {
            step.run();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            failures++;
            LOG.severe("failed: interrupted");
        } catch (Exception e) {
            failures++;
            LOG.severe("failed: " + e.getMessage());
        }
    }

    private static boolean has(String[] args, String name) {
        for (String a : args) {
            if (a.equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static String flag(String[] args, String name) {
        for (int i = 0; i < args.length; i++) {
            if (args[i].equals(name)) {
                if (i + 1 >= args.length) {
                    LOG.severe(name + " needs a value");
                    System.exit(2);
                }
                return args[i + 1];
            }
        }
        return null;
    }

    public static void main(String[] args) {
        if (API_KEY == null || API_KEY.isEmpty()) {
            LOG.severe("MATIH_API_KEY is required");
            System.exit(2);
        }
        final String uploadPath = flag(args, "--upload");
        final String inviteTarget = flag(args, "--invite");
        final String roleFlag = flag(args, "--role");
        final String inviteRole = roleFlag == null ? "user" : roleFlag;
        if (inviteTarget != null && !List.of("viewer", "user", "admin").contains(inviteRole)) {
            LOG.severe("--role must be viewer, user or admin");
            System.exit(2);
        }

        LOG.info("base url: " + BASE);
        runStep("ask", () -> ask("What were total sales last month?", null));
        runStep("ask in the background (respond-async)", () -> askAsync("How many orders came in last week?"));
        runStep("gems", MatihExample::listGems);
        runStep("dashboard image (wait=30, falls back to polling)", MatihExample::dashboardImage);
        if (!has(args, "--skip-predict")) {
            final String question = "Forecast next quarter's revenue.";
            if (has(args, "--background")) {
                runStep("predict, background variant", () -> predictBackground(question));
            } else {
                runStep("predict (wait=30, falls back to polling)", () -> predict(question));
            }
        }
        runStep("sources", MatihExample::listSources);
        if (uploadPath != null) {
            runStep("upload file", () -> uploadFile(uploadPath));
        }
        if (inviteTarget != null) {
            runStep("invite member", () -> inviteMember(inviteTarget, inviteRole));
        }
        System.exit(failures == 0 ? 0 : 1);
    }
}
