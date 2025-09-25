export const metadata = {
  title: "Cosette – Cal automation",
  description: "Webhook Cal.com -> Vercel",
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: "system-ui" }}>
        {children}
      </body>
    </html>
  );
}
