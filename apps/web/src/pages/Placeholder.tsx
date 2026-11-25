export function Placeholder({ title, phase }: { title: string; phase?: number }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">
        {phase ? `This screen arrives in Phase ${phase}.` : 'There is nothing at this address.'}
      </p>
    </section>
  );
}
