"""Tiny API server."""
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"hello world")


def main(port=8000):
    HTTPServer(("", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
