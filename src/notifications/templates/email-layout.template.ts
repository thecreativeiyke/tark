export interface EmailLayoutOptions {
  title: string;
  previewText?: string;
  bodyHtml: string;
  actionUrl?: string;
  actionText?: string;
}

export function renderEmailLayout(options: EmailLayoutOptions): string {
  const { title, previewText, bodyHtml, actionUrl, actionText } = options;

  const actionButton = actionUrl && actionText ? `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 28px 0;">
      <tr>
        <td align="left">
          <a href="${actionUrl}" target="_blank" style="display: inline-block; padding: 14px 28px; background-color: #10B981; color: #042F1F; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; letter-spacing: 0.2px; text-align: center;">
            ${actionText} &rarr;
          </a>
        </td>
      </tr>
    </table>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="google" content="notranslate">
  <meta name="x-apple-disable-message-reformatting">
  <title>${title}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td {font-family: Arial, Helvetica, sans-serif !important;}
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #0B0F19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #F8FAFC;">
  ${previewText ? `<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${previewText}</div>` : ''}

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #0B0F19; padding: 40px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 580px; background-color: #161B26; border-radius: 14px; border: 1px solid #232B3B; overflow: hidden;">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding: 32px 36px 20px 36px; border-bottom: 1px solid #1F2737;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-size: 22px; font-weight: 900; letter-spacing: 3px; color: #FFFFFF; text-transform: uppercase;">TARK</span>
                    <span style="display: inline-block; margin-left: 8px; padding: 2px 8px; font-size: 11px; font-weight: 700; color: #10B981; background-color: rgba(16, 185, 129, 0.12); border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.25); text-transform: uppercase; letter-spacing: 0.5px;">SAFE-LOCK</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Email Content -->
          <tr>
            <td style="padding: 36px 36px 28px 36px;">
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #FFFFFF; line-height: 1.35; letter-spacing: -0.3px;">
                ${title}
              </h1>

              <div style="font-size: 15px; line-height: 1.65; color: #CBD5E1;">
                ${bodyHtml}
              </div>

              ${actionButton}
            </td>
          </tr>

          <!-- Security Notice & Footer -->
          <tr>
            <td style="padding: 24px 36px; background-color: #10141E; border-top: 1px solid #1F2737;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size: 12px; line-height: 1.6; color: #64748B;">
                    <p style="margin: 0 0 8px 0; color: #94A3B8; font-weight: 600;">
                      🔒 Tark Protocol Security Guarantee
                    </p>
                    <p style="margin: 0 0 12px 0;">
                      Tark never asks for your password or full debit card PIN via email. Job Completion Codes (Handshake PINs) should only be exchanged in-person when physical service is inspected and completed.
                    </p>
                    <p style="margin: 0; font-size: 11px; color: #475569;">
                      &copy; ${new Date().getFullYear()} Tark Technologies. All rights reserved. On-Demand Dispatch & Safe-Lock Protocol.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
