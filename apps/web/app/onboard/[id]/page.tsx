import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function OnboardPage({ params }: PageProps<"/onboard/[id]">) {
  const { id } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Investor onboarding: {id}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Connect wallet → verify identity (simulated) → confirm eligibility → accept agreement (A15).
      </CardContent>
    </Card>
  );
}
