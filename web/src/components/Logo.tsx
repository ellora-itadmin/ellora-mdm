export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <img
      src="/ellora-logo.png"
      alt="Ellora EPC Pvt. Ltd."
      style={{ height: size, width: 'auto', display: 'block' }}
    />
  );
}
