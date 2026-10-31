// Matih API example: C# with HttpClient and System.Text.Json only. No NuGet packages.
//
// Run as a console project (.NET 8 or newer; the file uses top-level statements):
//   dotnet new console -n MatihExample && cd MatihExample
//   # replace Program.cs with this file (or copy it next to the .csproj and delete Program.cs)
//   export MATIH_API_KEY=mtk_...
//   dotnet run
//   dotnet run -- --skip-predict
//   dotnet run -- --background          (predict without Prefer: wait, start a job and poll it)
//   dotnet run -- --upload ./sales.csv
//   dotnet run -- --invite teammate@example.com --role ROLE   (admin action, never runs by default)
// With the .NET 10 SDK a single file also runs directly: dotnet run Example.cs -- --skip-predict
//
// Environment:
//   MATIH_API_KEY       required. Create one under Settings › API & MCP in Matih.
//   MATIH_BASE_URL      optional. Default https://workspace.matih.ai ("/api/v1" is appended).
//   MATIH_ON_DUPLICATE  optional. Passed as the on_duplicate form field of the file upload.
//
// Teaching example. Do not commit your API key.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

var apiKey = Environment.GetEnvironmentVariable("MATIH_API_KEY");
if (string.IsNullOrEmpty(apiKey))
{
    Console.Error.WriteLine("MATIH_API_KEY is required");
    return 2;
}
var rawBase = Environment.GetEnvironmentVariable("MATIH_BASE_URL");
if (string.IsNullOrEmpty(rawBase))
{
    rawBase = "https://workspace.matih.ai";
}
var baseUrl = rawBase.TrimEnd('/') + "/api/v1";

string? Flag(string name)
{
    var i = Array.IndexOf(args, name);
    if (i < 0) return null;
    if (i + 1 >= args.Length)
    {
        Console.Error.WriteLine($"{name} needs a value");
        Environment.Exit(2);
    }
    return args[i + 1];
}

bool Has(string name) => Array.IndexOf(args, name) >= 0;

var uploadPath = Flag("--upload");
var inviteTarget = Flag("--invite");
var inviteRole = Flag("--role");
if (inviteTarget != null && inviteRole == null)
{
    Console.Error.WriteLine("--invite needs --role ROLE (valid values come from GET /members)");
    return 2;
}

var client = new MatihClient(baseUrl, apiKey);
Console.WriteLine($"base url: {baseUrl}");

var failures = 0;

async Task Step(string name, Func<Task> body)
{
    Console.WriteLine();
    Console.WriteLine($"== {name} ==");
    try
    {
        await body();
    }
    catch (Exception e)
    {
        failures++;
        Console.Error.WriteLine($"failed: {e.Message}");
    }
}

await Step("ask", () => Examples.Ask(client, "What were total sales last month?"));
await Step("ask in the background (respond-async)", () => Examples.AskAsync(client, "How many orders came in last week?"));
await Step("gems", () => Examples.ListGems(client));
await Step("dashboard image (wait=30, falls back to polling)", () => Examples.DashboardImage(client));
if (!Has("--skip-predict"))
{
    const string question = "Forecast next quarter's revenue.";
    if (Has("--background"))
    {
        await Step("predict, background variant", () => Examples.PredictBackground(client, question));
    }
    else
    {
        await Step("predict (wait=30, falls back to polling)", () => Examples.Predict(client, question));
    }
}
await Step("sources", () => Examples.ListSources(client));
if (uploadPath != null)
{
    await Step("upload file", () => Examples.UploadFile(client, uploadPath));
}
if (inviteTarget != null)
{
    await Step("invite member", () => Examples.InviteMember(client, inviteTarget, inviteRole!));
}

return failures == 0 ? 0 : 1;

// ---------------------------------------------------------------------------
// The seven examples
// ---------------------------------------------------------------------------
static class Examples
{
    // Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds).
    private const int WaitSeconds = 30;

    // (1) Ask a question.
    // Costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
    // question and reuse the same key only when retrying that exact request.
    // The answer has a conversation_id: pass it back as conversationId (the
    // conversation_id body field) to ask a follow-up in the same conversation.
    public static async Task<string?> Ask(MatihClient c, string question, string? conversationId = null)
    {
        var payload = new Dictionary<string, string> { ["question"] = question };
        if (conversationId != null)
        {
            payload["conversation_id"] = conversationId;
        }
        var (_, answer) = await c.SendAsync(
            HttpMethod.Post, "/ask", () => Json.Body(payload), idempotencyKey: Guid.NewGuid().ToString());
        return PrintAnswer(answer);
    }

    private static string? PrintAnswer(JsonElement answer)
    {
        Console.WriteLine($"status: {Json.Str(answer, "status")}");
        Console.WriteLine($"answer: {Json.Str(answer, "answer")}");
        var clarification = Json.Prop(answer, "clarification");
        if (clarification != null)
        {
            Console.WriteLine($"clarification: {Json.Str(clarification.Value, "question")}");
        }
        var result = Json.Prop(answer, "result");
        if (result != null)
        {
            Console.WriteLine($"rows: {Json.Prop(result.Value, "row_count")}");
        }
        var conversation = Json.Str(answer, "conversation_id");
        Console.WriteLine($"conversation_id: {conversation} (pass it back to continue this conversation)");
        return conversation;
    }

    // (1b) Ask in the background (Prefer: respond-async).
    // POST /ask returns 202 at once with a Job of kind "ask". Poll GET /jobs/{id}; when it
    // succeeds the job's result is the same Answer that the synchronous call returns.
    public static async Task AskAsync(MatihClient c, string question)
    {
        var payload = new Dictionary<string, string> { ["question"] = question };
        var (status, job) = await c.SendAsync(
            HttpMethod.Post, "/ask", () => Json.Body(payload),
            idempotencyKey: Guid.NewGuid().ToString(), prefer: "respond-async");
        var jobId = Json.Str(job, "id")!;
        Console.WriteLine($"POST /ask answered {status}, job {jobId} (kind {Json.Str(job, "kind")})");
        var done = await c.WaitForJobAsync(jobId, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(8), TimeSpan.FromMinutes(5));
        PrintAnswer(Succeeded(done));
    }

    // Works on POST /gems/generate, /predictions and /dashboards/{id}/image. The server
    // answers 200 or 201 when the work finished within N seconds, otherwise 202 with a Job.
    // Either way this returns the result object; on 202 it falls back to polling the job.
    // If a finished answer carries a Job (it has a "state"), its result field is used.
    private static async Task<JsonElement> RunWithWait(
        MatihClient c, string path, Func<HttpContent>? content, string? idempotencyKey,
        TimeSpan firstDelay, TimeSpan maxDelay, TimeSpan timeout)
    {
        var (status, body) = await c.SendAsync(
            HttpMethod.Post, path, content, idempotencyKey, prefer: $"wait={WaitSeconds}");
        if (status == 202)
        {
            var jobId = Json.Str(body, "id")!;
            Console.WriteLine($"  not finished within {WaitSeconds}s (202), polling job {jobId}");
            return Succeeded(await c.WaitForJobAsync(jobId, firstDelay, maxDelay, timeout));
        }
        Console.WriteLine($"  finished within {WaitSeconds}s ({status})");
        return Json.Str(body, "state") != null ? Succeeded(body) : body;
    }

    // Returns the job's result, or throws with error.category and error.message.
    private static JsonElement Succeeded(JsonElement job)
    {
        var state = Json.Str(job, "state");
        if (state != "succeeded")
        {
            var error = Json.Prop(job, "error");
            var category = error == null ? "-" : Json.Str(error.Value, "category");
            var message = error == null ? "" : Json.Str(error.Value, "message");
            throw new InvalidOperationException($"job {Json.Str(job, "id")} {state}: [{category}] {message}");
        }
        return Json.Prop(job, "result") ?? Json.Parse("{}");
    }

    // (2) List Gems.
    public static async Task ListGems(MatihClient c)
    {
        var (_, data) = await c.SendAsync(HttpMethod.Get, "/gems");
        var count = 0;
        if (Json.Prop(data, "gems") is { ValueKind: JsonValueKind.Array } gems)
        {
            foreach (var gem in gems.EnumerateArray())
            {
                count++;
                Console.WriteLine($"  {Json.Str(gem, "id")}  {Json.Str(gem, "kind")}  {Json.Str(gem, "headline")}");
            }
        }
        Console.WriteLine($"state: {Json.Str(data, "state")}, {count} gem(s)");
    }

    // (3) Dashboard image job.
    // Sync-with-fallback: wait=N, and if the job is still running, poll GET /jobs/{id}
    // with a growing delay. image_url is a signed URL valid for about 15 minutes that
    // needs no Authorization header.
    public static async Task DashboardImage(MatihClient c)
    {
        var (_, data) = await c.SendAsync(HttpMethod.Get, "/dashboards");
        if (Json.Prop(data, "dashboards") is not { ValueKind: JsonValueKind.Array } list || list.GetArrayLength() == 0)
        {
            Console.WriteLine("no dashboards in this workspace");
            return;
        }
        var dashboard = list[0];
        var id = Json.Str(dashboard, "id")!;
        Console.WriteLine($"dashboard: {id} {Json.Str(dashboard, "title")}");
        var result = await RunWithWait(
            c, $"/dashboards/{Uri.EscapeDataString(id)}/image", null, null,
            TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(8), TimeSpan.FromMinutes(5));
        Console.WriteLine($"image_url: {Json.Str(result, "image_url")} ({Json.Prop(result, "width")}x{Json.Prop(result, "height")})");
    }

    // (4) Predict.
    // A prediction can run for up to 30 minutes. Poll every 5 to 10 seconds.
    // Webhooks (prediction.completed) avoid polling.
    private static void PrintPrediction(JsonElement result)
    {
        Console.WriteLine($"answer: {Json.Str(result, "answer")}");
        if (Json.Prop(result, "attachments") is { ValueKind: JsonValueKind.Array } attachments)
        {
            foreach (var attachment in attachments.EnumerateArray())
            {
                Console.WriteLine($"  attachment: {Json.Str(attachment, "type")}");
            }
        }
        var image = Json.Str(result, "image_url");
        if (image != null)
        {
            Console.WriteLine($"image_url: {image}");
        }
    }

    // Sync-with-fallback: wait=N, then poll on 202.
    public static async Task Predict(MatihClient c, string question)
    {
        var payload = new Dictionary<string, string> { ["question"] = question };
        var result = await RunWithWait(
            c, "/predictions", () => Json.Body(payload), Guid.NewGuid().ToString(),
            TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(31));
        PrintPrediction(result);
    }

    // Background variant: no Prefer header. POST /predictions returns 202 with a Job straight
    // away. Keep the job id (store it, hand it to another process) and poll GET /jobs/{id}
    // whenever you like; here we poll right after for the demo.
    public static async Task PredictBackground(MatihClient c, string question)
    {
        var payload = new Dictionary<string, string> { ["question"] = question };
        var (_, started) = await c.SendAsync(
            HttpMethod.Post, "/predictions", () => Json.Body(payload), idempotencyKey: Guid.NewGuid().ToString());
        var jobId = Json.Str(started, "id")!;
        Console.WriteLine($"started job {jobId}; poll GET /jobs/{jobId} later");
        var done = await c.WaitForJobAsync(jobId, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(31));
        PrintPrediction(Succeeded(done));
    }

    // (5) List sources.
    public static async Task ListSources(MatihClient c)
    {
        var (_, data) = await c.SendAsync(HttpMethod.Get, "/sources");
        var count = 0;
        if (Json.Prop(data, "sources") is { ValueKind: JsonValueKind.Array } sources)
        {
            foreach (var s in sources.EnumerateArray())
            {
                count++;
                Console.WriteLine(
                    $"  {Json.Str(s, "id")}  {Json.Str(s, "name")}  type={Json.Str(s, "type")}  " +
                    $"status={Json.Str(s, "status")}  active={Json.Prop(s, "active")}");
            }
        }
        if (count == 0)
        {
            Console.WriteLine("no sources yet");
        }
    }

    // (6) Upload a CSV or Excel file (multipart, field name "file").
    // Needs the files:write scope. The optional on_duplicate field says what to do
    // when the same file was uploaded before.
    public static async Task UploadFile(MatihClient c, string path)
    {
        var onDuplicate = Environment.GetEnvironmentVariable("MATIH_ON_DUPLICATE");
        HttpContent Build()
        {
            var form = new MultipartFormDataContent();
            if (!string.IsNullOrEmpty(onDuplicate))
            {
                form.Add(new StringContent(onDuplicate), "on_duplicate");
            }
            var file = new ByteArrayContent(File.ReadAllBytes(path));
            file.Headers.ContentType = MediaTypeHeaderValue.Parse(ContentTypeFor(path));
            form.Add(file, "file", Path.GetFileName(path));
            return form;
        }

        var (_, uploaded) = await c.SendAsync(HttpMethod.Post, "/files", Build);
        var id = Json.Str(uploaded, "id")!;
        var latest = uploaded;
        Console.WriteLine($"uploaded: {id} status={Json.Str(latest, "status")}");

        // Processing is asynchronous. Needs the files:read scope to follow it.
        for (var i = 0; i < 40 && Json.Str(latest, "status") == "processing"; i++)
        {
            await Task.Delay(TimeSpan.FromSeconds(3));
            (_, latest) = await c.SendAsync(HttpMethod.Get, $"/files/{Uri.EscapeDataString(id)}");
            Console.WriteLine($"  status={Json.Str(latest, "status")}");
        }
        Console.WriteLine(Json.Pretty(latest));
        if (Json.Prop(latest, "decision_required")?.ValueKind == JsonValueKind.True)
        {
            Console.WriteLine("the file needs a decision (duplicate handling); see POST /files/{id}/duplicate");
        }
    }

    private static string ContentTypeFor(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".csv" => "text/csv",
            ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".xls" => "application/vnd.ms-excel",
            _ => "application/octet-stream",
        };

    // (7) Invite a member (admin action, members:manage).
    // Only runs when you pass --invite. Valid role values come from GET /members.
    public static async Task InviteMember(MatihClient c, string target, string role)
    {
        var key = target.Contains('@') ? "email" : "phone";
        var payload = new Dictionary<string, string> { [key] = target, ["role"] = role };
        var (_, invitation) = await c.SendAsync(HttpMethod.Post, "/invitations", () => Json.Body(payload));
        Console.WriteLine(Json.Pretty(invitation));
    }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Errors from the API look like {"detail": {"category": "...", "message": "..."}}.
sealed class ApiException : Exception
{
    public int Status { get; }
    public string? Category { get; }

    private ApiException(int status, string? category, string message)
        : base($"HTTP {status} [{category ?? "unknown"}] {message}")
    {
        Status = status;
        Category = category;
    }

    public static ApiException From(int status, string body)
    {
        string? category = null;
        string? message = null;
        try
        {
            var root = Json.Parse(body);
            // detail can be a list or a string for validation errors; then we fall back to the raw body.
            if (Json.Prop(root, "detail") is { ValueKind: JsonValueKind.Object } detail)
            {
                category = Json.Str(detail, "category");
                message = Json.Str(detail, "message");
            }
        }
        catch (JsonException)
        {
        }
        message ??= body.Length > 300 ? body[..300] : body;
        return new ApiException(status, category, message);
    }
}

sealed class MatihClient
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(2) };
    private readonly string _base;

    public MatihClient(string baseUrl, string apiKey)
    {
        _base = baseUrl;
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    }

    // One request, returning the status code and decoded JSON body of a 2xx answer.
    // On a 429 it honours Retry-After once and retries with the same Idempotency-Key, so a
    // credit-costing call is never charged twice. content is a factory so a retry gets a
    // fresh body. prefer is an optional RFC 7240 Prefer header: "wait=30" or "respond-async".
    public async Task<(int Status, JsonElement Body)> SendAsync(
        HttpMethod method, string path, Func<HttpContent>? content = null,
        string? idempotencyKey = null, string? prefer = null)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, _base + path);
            if (content != null) request.Content = content();
            if (idempotencyKey != null) request.Headers.Add("Idempotency-Key", idempotencyKey);
            if (prefer != null) request.Headers.Add("Prefer", prefer);

            using var response = await _http.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            var status = (int)response.StatusCode;

            if (status == 429 && attempt == 0)
            {
                var wait = RetryAfterSeconds(response);
                Console.Error.WriteLine($"rate limited (429), waiting {wait:0}s and retrying once");
                await Task.Delay(TimeSpan.FromSeconds(wait));
                continue;
            }
            if (status < 200 || status > 299)
            {
                throw ApiException.From(status, text);
            }
            return (status, Json.Parse(text));
        }
    }

    private static double RetryAfterSeconds(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        if (header?.Delta is TimeSpan delta) return Math.Clamp(delta.TotalSeconds, 1, 60);
        if (header?.Date is DateTimeOffset date) return Math.Clamp((date - DateTimeOffset.UtcNow).TotalSeconds, 1, 60);
        return 5;
    }

    // Polls GET /jobs/{id} until the job is succeeded, failed or cancelled.
    // The delay starts at firstDelay and grows by 1.5x up to maxDelay.
    public async Task<JsonElement> WaitForJobAsync(string jobId, TimeSpan firstDelay, TimeSpan maxDelay, TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        var delay = firstDelay;
        while (true)
        {
            var (_, job) = await SendAsync(HttpMethod.Get, $"/jobs/{Uri.EscapeDataString(jobId)}");
            var state = Json.Str(job, "state");
            Console.WriteLine($"  job {jobId}: {state}");
            if (state is "succeeded" or "failed" or "cancelled") return job;
            if (clock.Elapsed + delay > timeout)
            {
                throw new TimeoutException($"timed out waiting for job {jobId} (last state {state})");
            }
            await Task.Delay(delay);
            delay = TimeSpan.FromMilliseconds(Math.Min(maxDelay.TotalMilliseconds, delay.TotalMilliseconds * 1.5));
        }
    }
}

static class Json
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    public static JsonElement Parse(string text)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
        return doc.RootElement.Clone();
    }

    public static HttpContent Body(object value) =>
        new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json");

    public static string Pretty(JsonElement element) => JsonSerializer.Serialize(element, Indented);

    // The property, or null when the element is not an object, the property is missing or JSON null.
    public static JsonElement? Prop(JsonElement element, string name)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind != JsonValueKind.Null)
        {
            return value;
        }
        return null;
    }

    public static string? Str(JsonElement element, string name)
    {
        var value = Prop(element, name);
        return value != null && value.Value.ValueKind == JsonValueKind.String ? value.Value.GetString() : null;
    }
}
