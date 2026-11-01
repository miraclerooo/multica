"use dom";

export default function MaterialPreview({
  html,
  dataUri,
  title,
}: {
  html: string;
  dataUri: string;
  title: string;
  dom?: import("expo/dom").DOMProps;
}) {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      srcDoc={html || undefined}
      src={html ? undefined : dataUri}
      style={{ width: "100%", height: 480, border: 0 }}
    />
  );
}
