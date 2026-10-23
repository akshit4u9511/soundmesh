# Security

SoundMesh is intended for trusted local networks, not public audio hosting.

Join invitations grant listening access. The separate host invitation grants transport, uploads, other-device settings, and room EQ access. The Windows launcher authenticates to its managed local instance rather than terminating arbitrary Node processes.

Local HTTP is unencrypted. Do not expose the server through router port forwarding or publish active invitations. Audio and settings are held in memory. `.soundmesh` contains private current invitations and logs and must not be published.

Please use [GitHub private vulnerability reporting](https://github.com/akshit4u9511/soundmesh/security/advisories/new) for security issues. Do not post credentials, active invitations, or private recordings in public issues. Use the issue templates for non-sensitive bugs.
