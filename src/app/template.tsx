/** Remounts per navigation, so each route arrives with one short rise (see .page-enter). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
