import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Eliteserien Fantasy',
  description: 'Statistics, team optimization, and decision support for Eliteserien Fantasy',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
