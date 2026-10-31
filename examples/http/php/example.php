<?php
// Matih API example: PHP with the curl extension and json_decode only. No Composer packages.
//
// Run (PHP 7.4 or newer with ext-curl and ext-json):
//   export MATIH_API_KEY=mtk_...
//   php example.php
//   php example.php --skip-predict
//   php example.php --background          (predict without Prefer: wait, start a job and poll it)
//   php example.php --upload ./sales.csv
//   php example.php --invite teammate@example.com --role ROLE   (admin action, never runs by default)
//
// Environment:
//   MATIH_API_KEY       required. Create one under Settings › API & MCP in Matih.
//   MATIH_BASE_URL      optional. Default https://workspace.matih.ai ("/api/v1" is appended).
//   MATIH_ON_DUPLICATE  optional. Passed as the on_duplicate form field of the file upload.
//
// Teaching example. Do not commit your API key.

declare(strict_types=1);

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Errors from the API look like {"detail": {"category": "...", "message": "..."}}.
class MatihApiException extends RuntimeException
{
    public int $status;
    public ?string $category;

    public function __construct(int $status, ?string $category, string $message)
    {
        parent::__construct('HTTP ' . $status . ' [' . ($category ?? 'unknown') . '] ' . $message);
        $this->status = $status;
        $this->category = $category;
    }
}

function matih_base_url(): string
{
    $raw = getenv('MATIH_BASE_URL');
    if ($raw === false || $raw === '') {
        $raw = 'https://workspace.matih.ai';
    }
    return rtrim($raw, '/') . '/api/v1';
}

function matih_uuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-'
        . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}

function matih_json($value): string
{
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function matih_pretty($value): string
{
    return json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * One request. Returns ['status' => int, 'data' => array] for a 2xx answer and throws
 * MatihApiException otherwise.
 *
 * $body is a JSON string, or an array for multipart (curl sets the boundary itself).
 * $headers are extra header lines such as "Idempotency-Key: ..." or "Prefer: wait=30".
 * On a 429 it honours Retry-After once and retries with the same headers, so a
 * credit-costing call carrying an Idempotency-Key is never charged twice.
 */
function matih_send(string $method, string $path, $body = null, array $headers = [], bool $retried = false): array
{
    $retryAfter = null;
    $ch = curl_init(matih_base_url() . $path);
    $lines = array_merge(['Authorization: Bearer ' . MATIH_API_KEY, 'Accept: application/json'], $headers);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $lines,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_HEADERFUNCTION => function ($handle, string $line) use (&$retryAfter): int {
            if (stripos($line, 'Retry-After:') === 0) {
                $retryAfter = trim(substr($line, strlen('Retry-After:')));
            }
            return strlen($line);
        },
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        $error = curl_error($ch);
        throw new RuntimeException('network error: ' . $error);
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

    if ($status === 429 && !$retried) {
        // Retry-After is normally a number of seconds; an HTTP date falls back to 1 second here.
        $wait = max(1, min(60, $retryAfter === null ? 5 : (int) $retryAfter));
        fwrite(STDERR, "rate limited (429), waiting {$wait}s and retrying once\n");
        sleep($wait);
        return matih_send($method, $path, $body, $headers, true);
    }

    $data = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($data)) {
        $data = [];
    }
    if ($status < 200 || $status > 299) {
        $detail = $data['detail'] ?? null;
        $category = is_array($detail) && isset($detail['category']) ? (string) $detail['category'] : null;
        $message = is_array($detail) && isset($detail['message']) ? (string) $detail['message'] : substr($raw, 0, 300);
        throw new MatihApiException($status, $category, $message);
    }
    return ['status' => $status, 'data' => $data];
}

/** Same as matih_send() but returns only the decoded body. */
function matih_request(string $method, string $path, $body = null, array $headers = []): array
{
    return matih_send($method, $path, $body, $headers)['data'];
}

/** POST a JSON payload. */
function matih_post_json(string $path, array $payload, array $headers = []): array
{
    return matih_send('POST', $path, matih_json($payload), array_merge(['Content-Type: application/json'], $headers));
}

/**
 * Poll GET /jobs/{id} until the job is succeeded, failed or cancelled.
 * The delay (in seconds) starts at $first and grows by 1.5x up to $max.
 */
function matih_wait_for_job(string $jobId, float $first, float $max, float $timeout): array
{
    $deadline = microtime(true) + $timeout;
    $delay = $first;
    while (true) {
        $job = matih_request('GET', '/jobs/' . rawurlencode($jobId));
        $state = (string) ($job['state'] ?? '');
        echo "  job $jobId: $state\n";
        if (in_array($state, ['succeeded', 'failed', 'cancelled'], true)) {
            return $job;
        }
        if (microtime(true) + $delay > $deadline) {
            throw new RuntimeException("timed out waiting for job $jobId (last state $state)");
        }
        usleep((int) round($delay * 1000000));
        $delay = min($max, $delay * 1.5);
    }
}

/** Returns the job result, or throws with error.category and error.message. */
function matih_require_succeeded(array $job): array
{
    if (($job['state'] ?? '') !== 'succeeded') {
        $error = $job['error'] ?? [];
        throw new RuntimeException(sprintf(
            'job %s %s: [%s] %s',
            $job['id'] ?? '?',
            $job['state'] ?? '?',
            $error['category'] ?? '-',
            $error['message'] ?? ''
        ));
    }
    return $job['result'] ?? [];
}

const MATIH_WAIT_SECONDS = 30;

/**
 * Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds).
 * Works on POST /gems/generate, /predictions and /dashboards/{id}/image. The server answers
 * 200 or 201 when the work finished within N seconds, otherwise 202 with a Job. Either way this
 * returns the result array; on 202 it falls back to polling the job.
 * If a finished answer carries a Job (it has a "state"), its result field is used.
 */
function matih_run_with_wait(string $path, ?array $payload, ?string $idempotencyKey, float $first, float $max, float $timeout): array
{
    $headers = ['Prefer: wait=' . MATIH_WAIT_SECONDS];
    if ($idempotencyKey !== null) {
        $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
    }
    if ($payload !== null) {
        $reply = matih_post_json($path, $payload, $headers);
    } else {
        $reply = matih_send('POST', $path, null, $headers);
    }
    if ($reply['status'] === 202) {
        $jobId = (string) ($reply['data']['id'] ?? '');
        echo '  not finished within ' . MATIH_WAIT_SECONDS . "s (202), polling job $jobId\n";
        return matih_require_succeeded(matih_wait_for_job($jobId, $first, $max, $timeout));
    }
    echo '  finished within ' . MATIH_WAIT_SECONDS . 's (' . $reply['status'] . ")\n";
    if (isset($reply['data']['state'])) {
        return matih_require_succeeded($reply['data']);
    }
    return $reply['data'];
}

// ---------------------------------------------------------------------------
// (1) Ask a question
// ---------------------------------------------------------------------------
// Costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
// question and reuse the same key only when retrying that exact request.
// The answer has a conversation_id: pass it back as $conversationId (the
// conversation_id body field) to ask a follow-up in the same conversation.
function example_ask(string $question, ?string $conversationId = null): ?string
{
    $payload = ['question' => $question];
    if ($conversationId !== null) {
        $payload['conversation_id'] = $conversationId;
    }
    $reply = matih_post_json('/ask', $payload, ['Idempotency-Key: ' . matih_uuid()]);
    return print_answer($reply['data']);
}

function print_answer(array $answer): ?string
{
    echo 'status: ' . ($answer['status'] ?? '') . "\n";
    echo 'answer: ' . ($answer['answer'] ?? '') . "\n";
    if (isset($answer['clarification']['question'])) {
        echo 'clarification: ' . $answer['clarification']['question'] . "\n";
        echo 'options: ' . matih_json($answer['clarification']['options'] ?? []) . "\n";
    }
    if (isset($answer['result']['row_count'])) {
        echo 'rows: ' . $answer['result']['row_count'] . "\n";
    }
    $conversation = isset($answer['conversation_id']) ? (string) $answer['conversation_id'] : null;
    echo "conversation_id: $conversation (pass it back to continue this conversation)\n";
    return $conversation;
}

// ---------------------------------------------------------------------------
// (1b) Ask in the background (Prefer: respond-async)
// ---------------------------------------------------------------------------
// POST /ask returns 202 at once with a Job of kind "ask". Poll GET /jobs/{id}; when it
// succeeds the job's result is the same Answer that the synchronous call returns.
function example_ask_async(string $question): void
{
    $reply = matih_post_json('/ask', ['question' => $question], [
        'Idempotency-Key: ' . matih_uuid(),
        'Prefer: respond-async',
    ]);
    $jobId = (string) ($reply['data']['id'] ?? '');
    echo 'POST /ask answered ' . $reply['status'] . ", job $jobId (kind " . ($reply['data']['kind'] ?? '?') . ")\n";
    $job = matih_wait_for_job($jobId, 1.0, 8.0, 300.0);
    print_answer(matih_require_succeeded($job));
}

// ---------------------------------------------------------------------------
// (2) List Gems
// ---------------------------------------------------------------------------
function example_list_gems(): void
{
    $data = matih_request('GET', '/gems');
    $gems = $data['gems'] ?? [];
    echo 'state: ' . ($data['state'] ?? '') . ', ' . count($gems) . " gem(s)\n";
    foreach ($gems as $gem) {
        echo '  ' . ($gem['id'] ?? '') . '  ' . ($gem['kind'] ?? '') . '  ' . ($gem['headline'] ?? '') . "\n";
    }
}

// ---------------------------------------------------------------------------
// (3) Dashboard image job
// ---------------------------------------------------------------------------
// Sync-with-fallback: wait=N, and if the job is still running, poll GET /jobs/{id}
// with a growing delay. image_url is a signed URL valid for about 15 minutes that
// needs no Authorization header.
function example_dashboard_image(): void
{
    $data = matih_request('GET', '/dashboards');
    $dashboards = $data['dashboards'] ?? [];
    if (count($dashboards) === 0) {
        echo "no dashboards in this workspace\n";
        return;
    }
    $dashboard = $dashboards[0];
    echo 'dashboard: ' . $dashboard['id'] . ' ' . ($dashboard['title'] ?? '') . "\n";
    $result = matih_run_with_wait('/dashboards/' . rawurlencode((string) $dashboard['id']) . '/image', null, null, 1.0, 8.0, 300.0);
    echo 'image_url: ' . ($result['image_url'] ?? '') . ' (' . ($result['width'] ?? '?') . 'x' . ($result['height'] ?? '?') . ")\n";
}

// ---------------------------------------------------------------------------
// (4) Predict
// ---------------------------------------------------------------------------
// A prediction can run for up to 30 minutes. Poll every 5 to 10 seconds.
// Webhooks (prediction.completed) avoid polling.
function print_prediction(array $result): void
{
    echo 'answer: ' . ($result['answer'] ?? '') . "\n";
    foreach ($result['attachments'] ?? [] as $attachment) {
        echo '  attachment: ' . ($attachment['type'] ?? '') . "\n";
    }
    if (!empty($result['image_url'])) {
        echo 'image_url: ' . $result['image_url'] . "\n";
    }
}

/** Sync-with-fallback: wait=N, then poll on 202. */
function example_predict(string $question): void
{
    $result = matih_run_with_wait('/predictions', ['question' => $question], matih_uuid(), 5.0, 10.0, 31 * 60.0);
    print_prediction($result);
}

/**
 * Background variant: no Prefer header. POST /predictions returns 202 with a Job straight
 * away. Keep the job id (store it, hand it to another process) and poll GET /jobs/{id}
 * whenever you like; here we poll right after for the demo.
 */
function example_predict_background(string $question): void
{
    $reply = matih_post_json('/predictions', ['question' => $question], ['Idempotency-Key: ' . matih_uuid()]);
    $jobId = (string) ($reply['data']['id'] ?? '');
    echo "started job $jobId; poll GET /jobs/$jobId later\n";
    $job = matih_wait_for_job($jobId, 5.0, 10.0, 31 * 60.0);
    print_prediction(matih_require_succeeded($job));
}

// ---------------------------------------------------------------------------
// (5) List sources
// ---------------------------------------------------------------------------
function example_list_sources(): void
{
    $data = matih_request('GET', '/sources');
    $sources = $data['sources'] ?? [];
    foreach ($sources as $s) {
        echo '  ' . ($s['id'] ?? '') . '  ' . ($s['name'] ?? '') . '  type=' . ($s['type'] ?? '')
            . '  status=' . ($s['status'] ?? '') . '  active=' . (!empty($s['active']) ? 'true' : 'false') . "\n";
    }
    if (count($sources) === 0) {
        echo "no sources yet\n";
    }
}

// ---------------------------------------------------------------------------
// (6) Upload a CSV or Excel file (multipart, field name "file")
// ---------------------------------------------------------------------------
// Needs the files:write scope. The optional on_duplicate field says what to do
// when the same file was uploaded before. Passing an array as the body makes curl
// send multipart/form-data and pick the boundary.
function matih_content_type_for(string $path): string
{
    $types = [
        'csv' => 'text/csv',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls' => 'application/vnd.ms-excel',
    ];
    return $types[strtolower(pathinfo($path, PATHINFO_EXTENSION))] ?? 'application/octet-stream';
}

function example_upload_file(string $path): void
{
    if (!is_readable($path)) {
        throw new RuntimeException("cannot read $path");
    }
    $form = ['file' => new CURLFile($path, matih_content_type_for($path), basename($path))];
    $onDuplicate = getenv('MATIH_ON_DUPLICATE');
    if ($onDuplicate !== false && $onDuplicate !== '') {
        $form['on_duplicate'] = $onDuplicate;
    }
    $file = matih_request('POST', '/files', $form);
    echo 'uploaded: ' . ($file['id'] ?? '?') . ' status=' . ($file['status'] ?? '?') . "\n";

    // Processing is asynchronous. Needs the files:read scope to follow it.
    for ($i = 0; $i < 40 && ($file['status'] ?? '') === 'processing'; $i++) {
        sleep(3);
        $file = matih_request('GET', '/files/' . rawurlencode((string) $file['id']));
        echo '  status=' . ($file['status'] ?? '?') . "\n";
    }
    echo matih_pretty($file) . "\n";
    if (!empty($file['decision_required'])) {
        echo "the file needs a decision (duplicate handling); see POST /files/{id}/duplicate\n";
    }
}

// ---------------------------------------------------------------------------
// (7) Invite a member (admin action, members:manage)
// ---------------------------------------------------------------------------
// Only runs when you pass --invite. Valid role values come from GET /members.
function example_invite_member(string $target, string $role): void
{
    $key = strpos($target, '@') !== false ? 'email' : 'phone';
    $reply = matih_post_json('/invitations', [$key => $target, 'role' => $role]);
    echo matih_pretty($reply['data']) . "\n";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main(): int
{
    $apiKey = getenv('MATIH_API_KEY');
    if ($apiKey === false || $apiKey === '') {
        fwrite(STDERR, "MATIH_API_KEY is required\n");
        return 2;
    }
    define('MATIH_API_KEY', $apiKey);

    $options = getopt('', ['upload:', 'invite:', 'role:', 'skip-predict', 'background']);
    $uploadPath = isset($options['upload']) && is_string($options['upload']) ? $options['upload'] : null;
    $inviteTarget = isset($options['invite']) && is_string($options['invite']) ? $options['invite'] : null;
    $inviteRole = isset($options['role']) && is_string($options['role']) ? $options['role'] : null;
    if ($inviteTarget !== null && $inviteRole === null) {
        fwrite(STDERR, "--invite needs --role ROLE (valid values come from GET /members)\n");
        return 2;
    }

    echo 'base url: ' . matih_base_url() . "\n";
    $failures = 0;
    $step = function (string $name, callable $fn) use (&$failures): void {
        echo "\n== $name ==\n";
        try {
            $fn();
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, 'failed: ' . $e->getMessage() . "\n");
        }
    };

    $step('ask', function () {
        example_ask('What were total sales last month?');
    });
    $step('ask in the background (respond-async)', function () {
        example_ask_async('How many orders came in last week?');
    });
    $step('gems', 'example_list_gems');
    $step('dashboard image (wait=30, falls back to polling)', 'example_dashboard_image');
    if (!array_key_exists('skip-predict', $options)) {
        $question = "Forecast next quarter's revenue.";
        if (array_key_exists('background', $options)) {
            $step('predict, background variant', function () use ($question) {
                example_predict_background($question);
            });
        } else {
            $step('predict (wait=30, falls back to polling)', function () use ($question) {
                example_predict($question);
            });
        }
    }
    $step('sources', 'example_list_sources');
    if ($uploadPath !== null) {
        $step('upload file', function () use ($uploadPath) {
            example_upload_file($uploadPath);
        });
    }
    if ($inviteTarget !== null) {
        $step('invite member', function () use ($inviteTarget, $inviteRole) {
            example_invite_member($inviteTarget, (string) $inviteRole);
        });
    }
    return $failures === 0 ? 0 : 1;
}

exit(main());
