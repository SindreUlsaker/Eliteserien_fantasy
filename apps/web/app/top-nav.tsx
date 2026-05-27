'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './theme-toggle';

type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: '/', label: 'Hjem' },
  { href: '/compare', label: 'Sammenlign' },
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <Link href="/" className="brand" aria-label="Go to home">
          <span className="brand-dot" aria-hidden="true" />
          <span className="brand-text">Eliteserien Fantasy</span>
        </Link>

        <nav className="nav-desktop" aria-label="Primary navigation">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link ${active ? 'is-active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="top-nav-actions">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
