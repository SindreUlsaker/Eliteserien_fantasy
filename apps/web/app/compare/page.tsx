'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '../user-context';

export default function ComparePage() {
  const router = useRouter();
  const { selectedEntry, isLoading } = useUser();

  useEffect(() => {
    if (isLoading) return;
    if (!selectedEntry) {
      router.replace('/');
    }
  }, [isLoading, selectedEntry, router]);

  // Mens vi laster: ikke render noe (unngår UI-flash)
  if (isLoading) return null;

  // Etter loading, men ingen entry: vi er på vei til '/'
  if (!selectedEntry) return null;

  return (
    <main className="container">
      <header className="page-header">
        <h1 className="page-title">Sammenlign</h1>
      </header>

      <section className="card card-pad">
        <h2 className="section-title">Kommer snart</h2>
        <p className="muted">
          Her skal vi sammenligne laget ditt med brukere på omtrent samme overall-rank.
        </p>

        <div className="muted" style={{ marginTop: 10 }}>
          Valgt lag: <b>{selectedEntry.entryName}</b> ({selectedEntry.id})
        </div>
      </section>
    </main>
  );
}
