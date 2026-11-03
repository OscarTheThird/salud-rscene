// Sends email through Gmail's SMTP server with an app password (GMAIL_USER and GMAIL_APP_PASSWORD in Vercel).
// Handlers call mailer.send(), so tests can replace it. nodemailer is loaded only when a message is actually sent.
export const mailer = {
  async send({ to, subject, text, html }) {
    const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error('Email is not configured');
    const { default: nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    await transport.sendMail({ from: `"SALUD private preview" <${user}>`, to, subject, text, html });
  },
};
