'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThemeToggle } from './theme-toggle';

type NavItem = { href: string; label: string };

const NAV: NavItem[] = [
  { href: '/', label: 'Hjem' },
  { href: '/compare', label: 'Sammenlign' },
];

export function TopNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="top-nav">
      <div className="top-nav-inner">
        <Link href="/" className="brand" aria-label="Go to home">
          <span className="brand-dot" aria-hidden="true" />
          <span className="brand-text">Eliteserien Fantasy</span>
        </Link>

        {/* Desktop tabs centered */}
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

        {/* Right side actions */}
        <div className="top-nav-actions">
          <ThemeToggle />

          <button
            type="button"
            className="btn btn-ghost nav-burger"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true">{open ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <nav className="nav-mobile card" aria-label="Mobile navigation">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-mobile-link ${active ? 'is-active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
