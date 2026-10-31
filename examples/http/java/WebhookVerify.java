// Matih webhook signature verification: plain Java (javax.crypto, java.security). No libraries.
//
// Run (Java 11 or newer, single-file source launch):
//   java WebhookVerify.java                 # self-test: signs a sample body and verifies it
//   export MATIH_WEBHOOK_SECRET=whsec_...
//   java WebhookVerify.java serve           # demo server on :8080, POST /matih/webhook
//   PORT=9000 java WebhookVerify.java serve
//
// Every delivery carries three headers:
//   Matih-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
//   Matih-Event:     the event name, for example gems.ready
//   Matih-Delivery:  a unique delivery id, handy for de-duplicating retries
//
// Rules implemented below:
//   1. Sign the RAW request bytes, not re-serialised JSON.
//   2. Reject when |now - t| > 300 seconds (replay protection).
//   3. The header may carry several v1 values; any one matching is enough.
//   4. Compare with a constant-time function (MessageDigest.isEqual).
//
// The whole secret string is used as the HMAC key, including the whsec_ prefix.
// Output goes through java.util.logging (to stderr, message only).
// Teaching example. Do not commit your webhook secret.

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.ConsoleHandler;
import java.util.logging.Formatter;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class WebhookVerify {

    private static final long TOLERANCE_SECONDS = 300;
    private static final int MAX_BODY_BYTES = 1024 * 1024;
    private static final Logger LOG = createLogger();

    private static Logger createLogger() {
        Logger logger = Logger.getLogger("matih.webhook");
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

    /**
     * Verifies a Matih-Signature header against the raw body.
     *
     * @param secret     the webhook secret (whsec_...), used as-is as the HMAC key
     * @param header     the Matih-Signature header value, may be null
     * @param rawBody    the exact bytes that were received
     * @param nowSeconds the current unix time in seconds (a parameter so it can be tested)
     */
    public static boolean verify(String secret, String header, byte[] rawBody, long nowSeconds) {
        if (header == null || header.isEmpty()) {
            return false;
        }
        String t = null;
        List<String> candidates = new ArrayList<>();
        for (String part : header.split(",")) {
            int eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            String key = part.substring(0, eq).trim();
            String value = part.substring(eq + 1).trim();
            if (key.equals("t")) {
                t = value;
            } else if (key.equals("v1")) {
                candidates.add(value);
            }
        }
        if (t == null || candidates.isEmpty()) {
            return false;
        }
        long timestamp;
        try {
            timestamp = Long.parseLong(t);
        } catch (NumberFormatException e) {
            return false;
        }
        if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
            return false;
        }

        byte[] expected = hmacSha256(secret, t, rawBody);
        boolean matched = false;
        for (String hex : candidates) {
            byte[] received = fromHex(hex);
            // MessageDigest.isEqual is constant-time for equal-length inputs.
            if (received != null && MessageDigest.isEqual(received, expected)) {
                matched = true;
            }
        }
        return matched;
    }

    /** HMAC-SHA256 over "<t>." followed by the raw body bytes. */
    static byte[] hmacSha256(String secret, String t, byte[] rawBody) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update((t + ".").getBytes(StandardCharsets.UTF_8));
            return mac.doFinal(rawBody);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }

    private static byte[] fromHex(String hex) {
        if (hex.length() % 2 != 0) {
            return null;
        }
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(hex.charAt(2 * i), 16);
            int lo = Character.digit(hex.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) {
                return null;
            }
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // Demo server: reads the RAW body, verifies, then answers 2xx quickly.
    // -----------------------------------------------------------------------
    static void serve(String secret, int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/matih/webhook", exchange -> handle(secret, exchange));
        server.start();
        LOG.info("listening on :" + port + ", POST /matih/webhook");
    }

    private static void handle(String secret, HttpExchange exchange) throws IOException {
        try {
            if (!"POST".equals(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }
            byte[] raw;
            try (InputStream in = exchange.getRequestBody()) {
                raw = in.readNBytes(MAX_BODY_BYTES + 1);
            }
            if (raw.length > MAX_BODY_BYTES) {
                exchange.sendResponseHeaders(413, -1);
                return;
            }
            String signature = exchange.getRequestHeaders().getFirst("Matih-Signature");
            if (!verify(secret, signature, raw, System.currentTimeMillis() / 1000)) {
                LOG.warning("rejected delivery: bad or stale signature");
                exchange.sendResponseHeaders(401, -1);
                return;
            }
            LOG.info("event=" + exchange.getRequestHeaders().getFirst("Matih-Event")
                    + " delivery=" + exchange.getRequestHeaders().getFirst("Matih-Delivery")
                    + " bytes=" + raw.length);
            // Answer 2xx quickly and do slow work elsewhere. Retries reuse Matih-Delivery.
            exchange.sendResponseHeaders(204, -1);
        } finally {
            exchange.close();
        }
    }

    // -----------------------------------------------------------------------
    // Self-test
    // -----------------------------------------------------------------------
    private static void selfTest() {
        String secret = "whsec_example";
        byte[] body = "{\"event\":\"gems.ready\"}".getBytes(StandardCharsets.UTF_8);
        long now = System.currentTimeMillis() / 1000;
        String header = "t=" + now + ",v1=" + toHex(hmacSha256(secret, String.valueOf(now), body));

        LOG.info("valid signature accepted:   " + verify(secret, header, body, now));
        LOG.info("tampered body rejected:     " + !verify(secret, header, "{}".getBytes(StandardCharsets.UTF_8), now));
        LOG.info("wrong secret rejected:      " + !verify("whsec_other", header, body, now));
        LOG.info("stale timestamp rejected:   " + !verify(secret, header, body, now + 301));
        LOG.info("second v1 value accepted:   " + verify(secret, "t=" + now + ",v1=00,v1="
                + toHex(hmacSha256(secret, String.valueOf(now), body)), body, now));
    }

    public static void main(String[] args) throws IOException {
        if (args.length > 0 && args[0].equals("serve")) {
            String secret = System.getenv("MATIH_WEBHOOK_SECRET");
            if (secret == null || secret.isEmpty()) {
                LOG.severe("MATIH_WEBHOOK_SECRET is required");
                System.exit(2);
            }
            String port = System.getenv("PORT");
            serve(secret, port == null || port.isEmpty() ? 8080 : Integer.parseInt(port));
        } else {
            selfTest();
        }
    }
}
