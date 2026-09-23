import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DistributionPage({ params }: PageProps<"/distributions/[id]">) {
  const { id } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Distribution {id}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Read-only history, allocations and signatures (A19).
      </CardContent>
    </Card>
  );
}
