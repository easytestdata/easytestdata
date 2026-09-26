import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge
} from "@easytestdata/ui";
import { useAuth } from "@/contexts/AuthContext";

function getInitials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function AccountSection() {
  const { user, isAdmin } = useAuth();

  if (!user) return null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your account information.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.avatarUrl ?? undefined} />
              <AvatarFallback className="bg-primary/10 text-lg text-primary">
                {getInitials(user.displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{user.displayName}</h3>
              <p className="text-sm text-muted-foreground">{user.email}</p>
              {isAdmin && <Badge>Admin</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
