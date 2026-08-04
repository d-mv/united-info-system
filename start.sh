#!/usr/bin/env ruby
# frozen_string_literal: true

# Zero-dependency static file server. Stdlib only (socket + no gems).
# Usage: ./start.sh [port] [root]
#   ./start.sh            -> serves ./ on port 8000
#   ./start.sh 3000       -> serves ./ on port 3000
#   ./start.sh 3000 ./www -> serves ./www on port 3000

require 'socket'
require 'time'
require 'uri'

PORT = (ARGV[0] || 8000).to_i
ROOT = File.expand_path(ARGV[1] || '.')

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
  # strip query string, decode percent-encoding
  clean = request_path.split('?').first.to_s
  clean = URI.decode_www_form_component(clean)
  clean = '/index.html' if clean == '/'

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

  # drain remaining headers
  while (line = socket.gets) && line != "\r\n"; end

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
