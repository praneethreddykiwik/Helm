# Helm auth e-mails: what to paste where (R207 light design)

These 8 files are the Supabase Auth e-mails in Helm's **light-only** design (white card, soft
light-green header band with the Helm logo, light-green button with dark text). They no longer switch
to a dark card in Outlook / Gmail / Apple Mail dark mode.

Do not edit the HTML by hand. They are generated from `supabase/functions/_shared/email-layout.mjs`
by `node scripts/gen-email-templates.mjs`.

## How to paste (staging `helm-staging` first, test, then prod)

Supabase dashboard → pick the project → **Authentication → Emails → Templates**.
For each row below: open that template, paste the **Subject**, switch the message body to the
source / HTML view, select everything and delete it, paste the **whole file**, then **Save changes**.
The two "security notification" rows are under the **Security** tab of the same Emails page
(turn the notification on if it is off).

| # | Supabase template (Authentication → Emails) | Paste this file | Subject |
|---|---|---|---|
| 1 | Templates → **Confirm signup** | `confirm-signup.html` | `Confirm your email for Helm` |
| 2 | Templates → **Invite user** | `invite-user.html` | `{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}Join your studio on Helm{{ end }}` |
| 3 | Templates → **Magic link** | `magic-link.html` | `{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}Your Helm sign-in link{{ end }}` |
| 4 | Templates → **Change email address** | `change-email.html` | `Confirm your new email for Helm` |
| 5 | Templates → **Reset password** | `reset-password.html` | `Reset your Helm password` |
| 6 | Templates → **Reauthentication** | `reauthentication.html` | `Your Helm verification code` |
| 7 | Security → **Password changed** | `password-changed.html` | `Your Helm password was changed` |
| 8 | Security → **Email address changed** | `email-changed.html` | `Your Helm sign-in email was changed` |

Paste each file into **its own** template only (the "Password changed" notification has no
one-time link, so it must not get the Reset-password body).

Links are unchanged from before: e.g. Reset password still points to
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`.

## Check it

On staging: use "Forgot password" with your own address, open the e-mail in Outlook (desktop and
web) and Gmail (web and phone) with dark mode ON. It should show a light page, a white card and a
light-green button whose text is dark and readable. Click the button: you land on "Choose a new
password". Then repeat the paste on prod.

More detail (link expiry, redirect URLs, SMTP): `docs/ops/EMAIL-TEMPLATES.md`.
