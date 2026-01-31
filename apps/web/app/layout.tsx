import type { Metadata } from 'next';
import './globals.css';
import { UserProvider } from './user-context';

export const metadata: Metadata = {
  title: 'Eliteserien Fantasy',
  description: 'Statistics, team optimization, and decision support for Eliteserien Fantasy',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no">
      <body>
        <UserProvider>{children}</UserProvider>
      </body>
    </html>
  );
}
