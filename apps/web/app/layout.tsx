import type { Metadata } from 'next';
import './globals.css';
import { UserProvider } from './user-context';
import { TopNav } from './top-nav';

export const metadata: Metadata = {
  title: 'Eliteserien Fantasy',
  description: 'Statistics, team optimization, and decision support for Eliteserien Fantasy',
};

const themeInitScript = `
(() => {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      document.body.dataset.theme = saved;
    }
  } catch {
    // do nothing → fallback to system
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no" suppressHydrationWarning>
      <body className="app-body">
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <UserProvider>
          <TopNav />
          {children}
        </UserProvider>
      </body>
    </html>
  );
}
