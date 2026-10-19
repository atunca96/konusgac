// E-mail: account verification and password reset, sent through Resend (resend.com).
// Without RESEND_API_KEY the server simply has no e-mail: sign-up does not ask for one and the
// "forgot password" link is hidden.

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

export function resendMailer(apiKey: string, from: string): Mailer {
  return async (mail) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// One simple layout for every mail: a greeting, a sentence, a button, and the link in plain text
// for clients that do not show buttons.
function layout(name: string, intro: string, button: string, link: string, outro: string): Pick<Mail, 'text' | 'html'> {
  const text = `Merhaba ${name},\n\n${intro}\n\n${link}\n\n${outro}\n\nKonuşgaç`;
  const html = `<!doctype html><html lang="tr"><body style="margin:0;background:#f2f3f5;font-family:Segoe UI,Arial,sans-serif">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:12px;padding:32px;color:#23262b">
<div style="font-size:22px;font-weight:700;color:#e8590c;margin-bottom:16px">Konuşgaç</div>
<p style="font-size:15px;line-height:1.5">Merhaba ${escape(name)},</p>
<p style="font-size:15px;line-height:1.5">${escape(intro)}</p>
<p style="margin:24px 0"><a href="${escape(link)}" style="background:#e8590c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escape(button)}</a></p>
<p style="font-size:13px;color:#5c6370;line-height:1.5">${escape(outro)}</p>
<p style="font-size:12px;color:#8a909a;word-break:break-all">${escape(link)}</p>
</div></body></html>`;
  return { text, html };
}

export function verifyMail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: 'Konuşgaç: e-posta adresini doğrula',
    ...layout(name, 'Konuşgaç hesabının e-posta adresini doğrulamak için aşağıdaki düğmeye bas.', 'E-postamı doğrula', link,
      'Bu bağlantı 24 saat geçerli. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.'),
  };
}

export function resetMail(to: string, name: string, username: string, link: string): Mail {
  return {
    to,
    subject: 'Konuşgaç: şifre sıfırlama',
    ...layout(name, `Konuşgaç hesabın (@${username}) için yeni bir şifre belirlemek üzere aşağıdaki düğmeye bas.`, 'Yeni şifre belirle', link,
      'Bu bağlantı 1 saat geçerli ve yalnızca bir kez kullanılabilir. Şifreni sıfırlamak istemediysen bu e-postayı yok sayabilirsin; şifren değişmez.'),
  };
}
