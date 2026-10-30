"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";

interface PasswordSignInProps {
  logo?: ReactNode;
  extra?: ReactNode;
  onLogin: (email: string, password: string, setupToken?: string) => Promise<void>;
}

export function PasswordSignIn({ logo, extra, onLogin }: PasswordSignInProps) {
  const { t } = useT("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupToken, setSetupToken] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("password-setup");
    if (token) {
      setSetupToken(token);
      // Fragments are not sent to the server. Remove this capability from
      // the visible URL/history as soon as the form has captured it.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (setupToken && password !== confirmation) {
      setError(t(($) => $.password.mismatch));
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onLogin(email, password, setupToken);
      setPassword("");
      setConfirmation("");
      setSetupToken(undefined);
    } catch {
      setError(t(($) => setupToken ? $.password.setup_failed : $.password.failed));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {logo && <div className="mx-auto mb-4">{logo}</div>}
          <CardTitle className="text-display-sm">{t(($) => setupToken ? $.password.setup_title : $.signin.title)}</CardTitle>
        </CardHeader>
        <CardContent>
          <form id="password-login" onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password-email">{t(($) => $.common.email)}</Label>
              <Input id="password-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="login-password">{t(($) => $.password.label)}</Label>
              <Input id="login-password" type="password" autoComplete={setupToken ? "new-password" : "current-password"} minLength={setupToken ? 12 : undefined} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} />
            </div>
            {setupToken && <div className="space-y-2">
              <Label htmlFor="confirm-password">{t(($) => $.password.confirm)}</Label>
              <Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={loading} />
              <p className="text-body text-muted-foreground">{t(($) => $.password.minimum)}</p>
            </div>}
            {error && <p role="alert" className="text-body text-destructive">{error}</p>}
          </form>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" form="password-login" className="w-full" size="lg" disabled={loading || !email || !password} aria-busy={loading}>
            {t(($) => setupToken ? $.password.setup_action : $.password.sign_in)}
          </Button>
          {!setupToken && <p className="text-body text-muted-foreground">{t(($) => $.password.recovery)}</p>}
          {extra && <div className="w-full pt-1 text-center">{extra}</div>}
        </CardFooter>
      </Card>
    </div>
  );
}
