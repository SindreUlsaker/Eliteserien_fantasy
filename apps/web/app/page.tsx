export default function Home() {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '2rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <h1
        style={{
          fontSize: '2.5rem',
          fontWeight: 'bold',
          marginBottom: '1rem',
          color: '#1a1a1a',
        }}
      >
        Eliteserien Fantasy – WIP
      </h1>
      <p style={{ color: '#666', fontSize: '1.1rem' }}>
        Development environment is being set up...
      </p>
    </main>
  );
}
