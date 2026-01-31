'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type EntryHit = {
  id: number;
  entryName: string;
  playerName: string;
  lastOverallRank: number | null;
  lastOverallTotal: number | null;
};

type UserContextType = {
  selectedEntry: EntryHit | null;
  setSelectedEntry: (entry: EntryHit | null) => void;
  entryId: number | null;
  isLoading: boolean;
};

const UserContext = createContext<UserContextType | undefined>(undefined);

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export function UserProvider({ children }: { children: ReactNode }) {
  const [selectedEntry, setSelectedEntry] = useState<EntryHit | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load from localStorage on mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const raw = localStorage.getItem('entryId');
        if (!raw) {
          setIsLoading(false);
          return;
        }
        const id = Number(raw);
        if (!Number.isFinite(id)) {
          setIsLoading(false);
          return;
        }

        // Fetch entry details
        const res = await fetch(`${API_BASE}/entries/search?q=${encodeURIComponent(String(id))}`);
        if (!res.ok) {
          setIsLoading(false);
          return;
        }
        const data = (await res.json()) as EntryHit[];
        if (Array.isArray(data) && data.length > 0) {
          setSelectedEntry(data[0]);
        }
      } catch {
        // Ignore errors
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);

  // Save to localStorage when selectedEntry changes
  useEffect(() => {
    if (selectedEntry) {
      try {
        localStorage.setItem('entryId', String(selectedEntry.id));
      } catch {
        // Ignore
      }
    } else {
      try {
        localStorage.removeItem('entryId');
      } catch {
        // Ignore
      }
    }
  }, [selectedEntry]);

  const value: UserContextType = {
    selectedEntry,
    setSelectedEntry,
    entryId: selectedEntry?.id ?? null,
    isLoading,
  };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
