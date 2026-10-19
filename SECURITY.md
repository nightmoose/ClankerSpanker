# Security Policy

ClankerSpanker runs an agent gateway that can execute code on your machine.
Treat the host token like a password and never expose port 8787 to the public
internet (use loopback and/or Tailscale).

The public site [https://clankerspanker.tech/](https://clankerspanker.tech/) is a static page.
In Chrome it calls the gateway on that computer over loopback. It does not
relay prompts, transcripts, or the host token. The threat model is on
[https://clankerspanker.tech/docs/](https://clankerspanker.tech/docs/).

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. We aim to acknowledge
reports within a few days.

## Supported versions

Only the latest `main` is supported.
