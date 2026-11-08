#!/usr/bin/env ruby
# frozen_string_literal: true

# Zero-dependency static file server. Stdlib only (socket + no gems).
# Usage: ./start.sh [port] [root]
#   ./start.sh            -> serves ./ on port 8000
#   ./start.sh 3000       -> serves ./ on port 3000
#   ./start.sh 3000 ./www -> serves ./www on port 3000

require 'socket'
require 'time'

PORT = (ARGV[0] || 8000).to_i
ROOT = File.expand_path(ARGV[1] || '.')

# Only answer requests addressed to this machine. A web page can point its own
# domain at 127.0.0.1 (DNS rebinding) and read local files; its Host header
# still names that domain, so it is refused here.
ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'].flat_map { |h| [h, "#{h}:#{PORT}"] }.freeze

$stdout.sync = true # so the "Serving" lines reach a pipe right away

MIME_TYPES = {
  '.html'  => 'text/html; charset=utf-8',
  '.htm'   => 'text/html; charset=utf-8',
  '.js'    => 'text/javascript; charset=utf-8', # required for ES module scripts
  '.mjs'   => 'text/javascript; charset=utf-8',
  '.css'   => 'text/css; charset=utf-8',
  '.json'  => 'application/json; charset=utf-8',
  '.svg'   => 'image/svg+xml',
  '.png'   => 'image/png',
  '.jpg'   => 'image/jpeg',
  '.jpeg'  => 'image/jpeg',
  '.gif'   => 'image/gif',
  '.ico'   => 'image/x-icon',
  '.webp'  => 'image/webp',
  '.woff'  => 'font/woff',
  '.woff2' => 'font/woff2',
  '.ttf'   => 'font/ttf',
  '.wasm'  => 'application/wasm',
  '.txt'   => 'text/plain; charset=utf-8',
}.freeze

DEFAULT_MIME = 'application/octet-stream'

def mime_for(path)
  MIME_TYPES[File.extname(path).downcase] || DEFAULT_MIME
end

def resolved_path(request_path)
  # strip query string, decode percent-encoding. Paths keep '+' literal
  # ('+' means space only in form data), so decode %XX by hand: works on any Ruby.
  clean = request_path.split('?').first.to_s
  clean = clean.gsub(/%\h\h/) { |escape| escape[1, 2].hex.chr }.force_encoding(Encoding::UTF_8)
  clean = '/index.html' if clean == '/'

  # never serve dotfiles or dot-directories (.git, .gitignore, ...); this also rejects '..'
  return nil if clean.split('/').any? { |segment| segment.start_with?('.') }

  full = File.expand_path(File.join(ROOT, clean))

  # prevent path traversal — resolved path must stay inside ROOT
  return nil unless full.start_with?(ROOT + File::SEPARATOR) || full == ROOT

  full
end

def send_response(socket, status, status_text, headers, body = nil)
  socket.write "HTTP/1.1 #{status} #{status_text}\r\n"
  headers.each { |k, v| socket.write "#{k}: #{v}\r\n" }
  socket.write "\r\n"
  socket.write body if body
rescue StandardError => e
  warn "[send_response error] #{e.class}: #{e.message}"
end

def handle_request(socket)
  # Harden against blocked/hanging connections with timeout
  socket.timeout = 5 if socket.respond_to?(:timeout=)

  request_line = socket.gets
  return unless request_line

  method, path, = request_line.split(' ')

  host = nil
  while (line = socket.gets) && line != "\r\n"
    name, value = line.split(':', 2)
    host = value.strip.downcase if value && name.strip.casecmp?('host')
  end

  unless ALLOWED_HOSTS.include?(host)
    body = "403 Forbidden\n"
    send_response(socket, 403, 'Forbidden',
                  { 'Content-Type' => 'text/plain', 'Content-Length' => body.bytesize.to_s, 'Connection' => 'close' },
                  method == 'HEAD' ? nil : body)
    return
  end

  unless %w[GET HEAD].include?(method)
    body = "405 Method Not Allowed\n"
    send_response(socket, 405, 'Method Not Allowed',
                  { 'Content-Type' => 'text/plain', 'Content-Length' => body.bytesize.to_s, 'Connection' => 'close' },
                  method == 'HEAD' ? nil : body)
    return
  end

  full_path = resolved_path(path)

  if full_path.nil? || !File.exist?(full_path) || File.directory?(full_path)
    body = "404 Not Found: #{path}\n"
    send_response(socket, 404, 'Not Found',
                  { 'Content-Type' => 'text/plain', 'Content-Length' => body.bytesize.to_s, 'Connection' => 'close' },
                  method == 'HEAD' ? nil : body)
    return
  end

  body = File.binread(full_path)
  headers = {
    'Content-Type' => mime_for(full_path),
    'Content-Length' => body.bytesize.to_s,
    'Cache-Control' => 'no-cache',
    'Connection' => 'close',
  }
  send_response(socket, 200, 'OK', headers, method == 'HEAD' ? nil : body)
rescue StandardError => e
  warn "[error] #{e.class}: #{e.message}"
  begin
    body = "500 Internal Server Error\n"
    send_response(socket, 500, 'Internal Server Error',
                  { 'Content-Type' => 'text/plain', 'Content-Length' => body.bytesize.to_s, 'Connection' => 'close' }, body)
  rescue StandardError
    nil
  end
ensure
  socket.close rescue nil
end

server = TCPServer.new('127.0.0.1', PORT)
puts "Serving #{ROOT}"
puts "-> http://localhost:#{PORT}"
puts 'Ctrl+C to stop'

trap('INT') do
  puts "\nStopping."
  exit
end

loop do
  client = server.accept
  Thread.new(client) { |socket| handle_request(socket) }
end
