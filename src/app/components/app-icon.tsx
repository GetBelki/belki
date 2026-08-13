const BELKI_LOGO_URL = "/belki-logo.svg";

export function AppIcon({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={["app-icon", className].filter(Boolean).join(" ")}
      height={size}
      src={BELKI_LOGO_URL}
      width={size}
    />
  );
}
