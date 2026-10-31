# frozen_string_literal: true

# Matih API example: Ruby with Net::HTTP and json from the standard library. No gems.
#
# Run (Ruby 2.7 or newer):
#   export MATIH_API_KEY=mtk_...
#   ruby example.rb
#   ruby example.rb --skip-predict
#   ruby example.rb --background          (predict without Prefer: wait, start a job and poll it)
#   ruby example.rb --upload ./sales.csv
#   ruby example.rb --invite teammate@example.com --role ROLE   (admin action, never runs by default)
#
# Environment:
#   MATIH_API_KEY       required. Create one under Settings › API & MCP in Matih.
#   MATIH_BASE_URL      optional. Default https://workspace.matih.ai ("/api/v1" is appended).
#   MATIH_ON_DUPLICATE  optional. Passed as the on_duplicate form field of the file upload.
#
# Teaching example. Do not commit your API key.

require 'json'
require 'net/http'
require 'securerandom'
require 'time'
require 'uri'

# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

# Errors from the API look like {"detail": {"category": "...", "message": "..."}}.
class MatihApiError < StandardError
  attr_reader :status, :category

  def initialize(status, category, message)
    @status = status
    @category = category
    super("HTTP #{status} [#{category || 'unknown'}] #{message}")
  end
end

class MatihClient
  # Result of one request: the status code and the decoded JSON body (a Hash, or {}).
  Reply = Struct.new(:status, :data)

  def initialize(base_url, api_key)
    @base = URI(base_url)
    @api_key = api_key
    @http = Net::HTTP.new(@base.host, @base.port)
    @http.use_ssl = (@base.scheme == 'https')
    @http.open_timeout = 10
    @http.read_timeout = 120
  end

  # One request. On a 429 it honours Retry-After once and retries with the same
  # Idempotency-Key, so a credit-costing call is never charged twice.
  #
  # json:     a Hash sent as the JSON body
  # form:     an Array of Net::HTTP set_form entries, sent as multipart/form-data
  # headers:  extra headers, for example 'Prefer' => 'wait=30' or 'Idempotency-Key' => '...'
  def send_request(method, path, json: nil, form: nil, headers: {}, retried: false)
    uri = URI(@base.to_s + path)
    request = Net::HTTP.const_get(method.to_s.capitalize).new(uri)
    request['Authorization'] = "Bearer #{@api_key}"
    request['Accept'] = 'application/json'
    headers.each { |name, value| request[name] = value }
    if json
      request['Content-Type'] = 'application/json'
      request.body = JSON.generate(json)
    elsif form
      request.set_form(form, 'multipart/form-data')
    end

    response = @http.request(request)
    status = response.code.to_i

    if status == 429 && !retried
      wait = retry_after_seconds(response['Retry-After'])
      warn "rate limited (429), waiting #{wait}s and retrying once"
      sleep(wait)
      # A file in a multipart form was already read; rewind it so the retry sends the whole upload.
      form&.each { |_name, value, *| value.rewind if value.respond_to?(:rewind) }
      return send_request(method, path, json: json, form: form, headers: headers, retried: true)
    end

    body = response.body.to_s
    data = begin
      parsed = body.empty? ? {} : JSON.parse(body)
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError
      {}
    end
    unless status.between?(200, 299)
      detail = data['detail']
      category = detail.is_a?(Hash) ? detail['category'] : nil
      message = detail.is_a?(Hash) && detail['message'] ? detail['message'] : body[0, 300]
      raise MatihApiError.new(status, category, message)
    end
    Reply.new(status, data)
  end

  # Same as send_request but returns only the decoded body.
  def request(method, path, **options)
    send_request(method, path, **options).data
  end

  # Poll GET /jobs/{id} until the job is succeeded, failed or cancelled.
  # The delay (seconds) starts at first and grows by 1.5x up to max.
  def wait_for_job(job_id, first:, max:, timeout:)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    delay = first
    loop do
      job = request(:get, "/jobs/#{URI.encode_www_form_component(job_id)}")
      state = job['state']
      puts "  job #{job_id}: #{state}"
      return job if %w[succeeded failed cancelled].include?(state)

      if Process.clock_gettime(Process::CLOCK_MONOTONIC) + delay > deadline
        raise "timed out waiting for job #{job_id} (last state #{state})"
      end

      sleep(delay)
      delay = [max, delay * 1.5].min
    end
  end

  private

  # Retry-After is a number of seconds or an HTTP date. Clamp to 1..60.
  def retry_after_seconds(value)
    return 5 if value.nil?

    seconds = Integer(value.strip, 10)
    seconds.clamp(1, 60)
  rescue ArgumentError
    begin
      (Time.httpdate(value) - Time.now).ceil.clamp(1, 60)
    rescue ArgumentError
      5
    end
  end
end

# Returns the job result, or raises with error.category and error.message.
def require_succeeded(job)
  unless job['state'] == 'succeeded'
    error = job['error'] || {}
    raise "job #{job['id']} #{job['state']}: [#{error['category'] || '-'}] #{error['message']}"
  end
  job['result'] || {}
end

WAIT_SECONDS = 30

# Sync with a bounded wait: "Prefer: wait=N" (N up to 60 seconds).
# Works on POST /gems/generate, /predictions and /dashboards/{id}/image. The server answers
# 200 or 201 when the work finished within N seconds, otherwise 202 with a Job. Either way
# this returns the result Hash; on 202 it falls back to polling the job.
# If a finished answer carries a Job (it has a "state"), its result field is used.
def run_with_wait(client, path, payload: nil, idempotency_key: nil, first:, max:, timeout:)
  headers = { 'Prefer' => "wait=#{WAIT_SECONDS}" }
  headers['Idempotency-Key'] = idempotency_key if idempotency_key
  reply = client.send_request(:post, path, json: payload, headers: headers)
  if reply.status == 202
    job_id = reply.data['id']
    puts "  not finished within #{WAIT_SECONDS}s (202), polling job #{job_id}"
    return require_succeeded(client.wait_for_job(job_id, first: first, max: max, timeout: timeout))
  end

  puts "  finished within #{WAIT_SECONDS}s (#{reply.status})"
  reply.data.key?('state') ? require_succeeded(reply.data) : reply.data
end

# ---------------------------------------------------------------------------
# (1) Ask a question
# ---------------------------------------------------------------------------
# Costs credits, so it carries an Idempotency-Key. Use a fresh key for each new
# question and reuse the same key only when retrying that exact request.
# The answer has a conversation_id: pass it back as conversation_id: (the
# conversation_id body field) to ask a follow-up in the same conversation.
def ask(client, question, conversation_id: nil)
  payload = { 'question' => question }
  payload['conversation_id'] = conversation_id if conversation_id
  answer = client.request(:post, '/ask', json: payload,
                                         headers: { 'Idempotency-Key' => SecureRandom.uuid })
  print_answer(answer)
end

def print_answer(answer)
  puts "status: #{answer['status']}"
  puts "answer: #{answer['answer']}"
  clarification = answer['clarification']
  if clarification
    puts "clarification: #{clarification['question']}"
    puts "options: #{JSON.generate(clarification['options'])}"
  end
  puts "rows: #{answer['result']['row_count']}" if answer['result']
  puts "conversation_id: #{answer['conversation_id']} (pass it back to continue this conversation)"
  answer['conversation_id']
end

# ---------------------------------------------------------------------------
# (1b) Ask in the background (Prefer: respond-async)
# ---------------------------------------------------------------------------
# POST /ask returns 202 at once with a Job of kind "ask". Poll GET /jobs/{id}; when it
# succeeds the job's result is the same Answer that the synchronous call returns.
def ask_async(client, question)
  reply = client.send_request(:post, '/ask', json: { 'question' => question },
                                             headers: { 'Idempotency-Key' => SecureRandom.uuid,
                                                        'Prefer' => 'respond-async' })
  job_id = reply.data['id']
  puts "POST /ask answered #{reply.status}, job #{job_id} (kind #{reply.data['kind']})"
  job = client.wait_for_job(job_id, first: 1, max: 8, timeout: 300)
  print_answer(require_succeeded(job))
end

# ---------------------------------------------------------------------------
# (2) List Gems
# ---------------------------------------------------------------------------
def list_gems(client)
  data = client.request(:get, '/gems')
  gems = data['gems'] || []
  puts "state: #{data['state']}, #{gems.length} gem(s)"
  gems.each { |gem| puts "  #{gem['id']}  #{gem['kind']}  #{gem['headline']}" }
end

# ---------------------------------------------------------------------------
# (3) Dashboard image job
# ---------------------------------------------------------------------------
# Sync-with-fallback: wait=N, and if the job is still running, poll GET /jobs/{id}
# with a growing delay. image_url is a signed URL valid for about 15 minutes that
# needs no Authorization header.
def dashboard_image(client)
  dashboards = client.request(:get, '/dashboards')['dashboards'] || []
  if dashboards.empty?
    puts 'no dashboards in this workspace'
    return
  end
  dashboard = dashboards.first
  puts "dashboard: #{dashboard['id']} #{dashboard['title']}"
  result = run_with_wait(client, "/dashboards/#{URI.encode_www_form_component(dashboard['id'])}/image",
                         first: 1, max: 8, timeout: 300)
  puts "image_url: #{result['image_url']} (#{result['width']}x#{result['height']})"
end

# ---------------------------------------------------------------------------
# (4) Predict
# ---------------------------------------------------------------------------
# A prediction can run for up to 30 minutes. Poll every 5 to 10 seconds.
# Webhooks (prediction.completed) avoid polling.
def print_prediction(result)
  puts "answer: #{result['answer']}"
  (result['attachments'] || []).each { |attachment| puts "  attachment: #{attachment['type']}" }
  puts "image_url: #{result['image_url']}" if result['image_url']
end

# Sync-with-fallback: wait=N, then poll on 202.
def predict(client, question)
  result = run_with_wait(client, '/predictions', payload: { 'question' => question },
                                                 idempotency_key: SecureRandom.uuid,
                                                 first: 5, max: 10, timeout: 31 * 60)
  print_prediction(result)
end

# Background variant: no Prefer header. POST /predictions returns 202 with a Job straight
# away. Keep the job id (store it, hand it to another process) and poll GET /jobs/{id}
# whenever you like; here we poll right after for the demo.
def predict_background(client, question)
  job = client.request(:post, '/predictions', json: { 'question' => question },
                                              headers: { 'Idempotency-Key' => SecureRandom.uuid })
  puts "started job #{job['id']}; poll GET /jobs/#{job['id']} later"
  done = client.wait_for_job(job['id'], first: 5, max: 10, timeout: 31 * 60)
  print_prediction(require_succeeded(done))
end

# ---------------------------------------------------------------------------
# (5) List sources
# ---------------------------------------------------------------------------
def list_sources(client)
  sources = client.request(:get, '/sources')['sources'] || []
  sources.each do |s|
    puts "  #{s['id']}  #{s['name']}  type=#{s['type']}  status=#{s['status']}  active=#{s['active']}"
  end
  puts 'no sources yet' if sources.empty?
end

# ---------------------------------------------------------------------------
# (6) Upload a CSV or Excel file (multipart, field name "file")
# ---------------------------------------------------------------------------
# Needs the files:write scope. The optional on_duplicate field says what to do
# when the same file was uploaded before. Net::HTTP's set_form builds the multipart body.
CONTENT_TYPES = {
  '.csv' => 'text/csv',
  '.xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls' => 'application/vnd.ms-excel'
}.freeze

def upload_file(client, path)
  raise "cannot read #{path}" unless File.file?(path) && File.readable?(path)

  content_type = CONTENT_TYPES.fetch(File.extname(path).downcase, 'application/octet-stream')
  file = nil
  begin
    file = File.open(path, 'rb')
    form = []
    on_duplicate = ENV['MATIH_ON_DUPLICATE']
    form << ['on_duplicate', on_duplicate] if on_duplicate && !on_duplicate.empty?
    form << ['file', file, { filename: File.basename(path), content_type: content_type }]
    uploaded = client.request(:post, '/files', form: form)
  ensure
    file&.close
  end

  puts "uploaded: #{uploaded['id']} status=#{uploaded['status']}"
  # Processing is asynchronous. Needs the files:read scope to follow it.
  40.times do
    break unless uploaded['status'] == 'processing'

    sleep(3)
    uploaded = client.request(:get, "/files/#{URI.encode_www_form_component(uploaded['id'])}")
    puts "  status=#{uploaded['status']}"
  end
  puts JSON.pretty_generate(uploaded)
  puts 'the file needs a decision (duplicate handling); see POST /files/{id}/duplicate' if uploaded['decision_required']
end

# ---------------------------------------------------------------------------
# (7) Invite a member (admin action, members:manage)
# ---------------------------------------------------------------------------
# Only runs when you pass --invite. Valid role values come from GET /members.
def invite_member(client, target, role)
  key = target.include?('@') ? 'email' : 'phone'
  invitation = client.request(:post, '/invitations', json: { key => target, 'role' => role })
  puts JSON.pretty_generate(invitation)
end

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def option_value(args, name)
  index = args.index(name)
  return nil unless index

  value = args[index + 1]
  if value.nil? || value.start_with?('--')
    warn "#{name} needs a value"
    exit 2
  end
  value
end

def main(args)
  api_key = ENV['MATIH_API_KEY']
  if api_key.nil? || api_key.empty?
    warn 'MATIH_API_KEY is required'
    return 2
  end
  raw_base = ENV['MATIH_BASE_URL']
  raw_base = 'https://workspace.matih.ai' if raw_base.nil? || raw_base.empty?
  base_url = raw_base.sub(%r{/+\z}, '') + '/api/v1'

  upload_path = option_value(args, '--upload')
  invite_target = option_value(args, '--invite')
  invite_role = option_value(args, '--role')
  if invite_target && invite_role.nil?
    warn '--invite needs --role ROLE (valid values come from GET /members)'
    return 2
  end

  client = MatihClient.new(base_url, api_key)
  puts "base url: #{base_url}"

  failures = 0
  step = lambda do |name, &body|
    puts
    puts "== #{name} =="
    begin
      body.call
    rescue StandardError => e
      failures += 1
      warn "failed: #{e.message}"
    end
  end

  step.call('ask') { ask(client, 'What were total sales last month?') }
  step.call('ask in the background (respond-async)') { ask_async(client, 'How many orders came in last week?') }
  step.call('gems') { list_gems(client) }
  step.call('dashboard image (wait=30, falls back to polling)') { dashboard_image(client) }
  unless args.include?('--skip-predict')
    question = "Forecast next quarter's revenue."
    if args.include?('--background')
      step.call('predict, background variant') { predict_background(client, question) }
    else
      step.call('predict (wait=30, falls back to polling)') { predict(client, question) }
    end
  end
  step.call('sources') { list_sources(client) }
  step.call('upload file') { upload_file(client, upload_path) } if upload_path
  step.call('invite member') { invite_member(client, invite_target, invite_role) } if invite_target

  failures.zero? ? 0 : 1
end

exit(main(ARGV)) if $PROGRAM_NAME == __FILE__
