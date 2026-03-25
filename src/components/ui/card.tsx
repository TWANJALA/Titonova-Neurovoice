import * as React from "react";

function classNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = React.forwardRef<HTMLDivElement, DivProps>(function Card(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={classNames(
        "rounded-2xl border border-slate-200 bg-white/90 backdrop-blur-sm",
        className
      )}
      {...props}
    />
  );
});

export const CardContent = React.forwardRef<HTMLDivElement, DivProps>(function CardContent(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={classNames("p-4", className)} {...props} />;
});
