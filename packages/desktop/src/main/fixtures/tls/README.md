Test-only: a self-signed P-256 certificate and its private key for the loopback TLS handshakes in
`src/main/tlsPolicy.test.ts` (CN and SAN `localhost`, `127.0.0.1`). The key protects nothing; never use it
outside tests.
