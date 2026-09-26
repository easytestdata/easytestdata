import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useTeamMembers, useTeams } from "@/api/hooks";
import { inviteTeamMember, getTeamInvites, removeTeamMember, revokeTeamInvite } from "@/api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, UserPlus, Loader2, Copy, ArrowRightLeft, UserMinus, X } from "lucide-react";
import {
  EmptyTeamSvg,
  EmptyState,
  Button,
  Input,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Avatar,
  AvatarFallback,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@easytestdata/ui";

function getInitials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function TeamSection() {
  const { teamId, user, switchTeam } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: teams } = useTeams();
  const currentTeam = teams?.find((t) => t.id === teamId);
  const canInvite = currentTeam?.role === "owner" || currentTeam?.role === "admin";
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [sharedInvite, setSharedInvite] = useState<{ email: string; url: string } | null>(null);

  const handleSwitch = async (nextTeamId: string) => {
    if (switchingTo) return;
    setSwitchingTo(nextTeamId);
    try {
      await switchTeam(nextTeamId);
      // Everything cached belongs to the previous team.
      queryClient.clear();
      toast.success("Switched team");
      navigate("/home");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch team");
    } finally {
      setSwitchingTo(null);
    }
  };

  const copyInviteUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  };

  const canRemove = (memberRole: string, memberUserId: string) => {
    if (memberRole === "owner") return false;
    if (memberUserId === user?.id) return true; // leave the team
    if (currentTeam?.role === "owner") return true;
    return currentTeam?.role === "admin" && memberRole === "member";
  };

  const handleRemove = async (memberUserId: string, label: string) => {
    if (!teamId) return;
    const leaving = memberUserId === user?.id;
    if (!window.confirm(leaving ? "Leave this team?" : `Remove ${label} from the team?`)) return;
    try {
      await removeTeamMember(teamId, memberUserId);
      if (leaving) {
        // The current session belongs to a team we just left: the next request is refused and
        // the client refreshes into another team, so start from a clean slate.
        queryClient.clear();
        navigate("/home");
        return;
      }
      toast.success(`${label} removed`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!teamId) return;
    try {
      await revokeTeamInvite(teamId, inviteId);
      toast.success("Invite revoked");
      refetchInvites();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke invite");
    }
  };
  const { data: members, isLoading, refetch } = useTeamMembers(teamId ?? "");
  const { data: invites = [], refetch: refetchInvites } = useQuery({
    queryKey: ["team-invites", teamId],
    queryFn: () => getTeamInvites(teamId!),
    enabled: !!teamId
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [inviting, setInviting] = useState(false);

  const handleInvite = async () => {
    const inviteEmail = email.trim();
    if (!teamId || !inviteEmail || inviting) return;
    setInviting(true);
    try {
      const invite = await inviteTeamMember(teamId, inviteEmail, role);
      // The inviter shares the link; a pending invite to the same address gets a new link.
      setSharedInvite({ email: invite.email || inviteEmail, url: invite.inviteUrl });
      toast.success(
        invite.alreadyPending
          ? "New invite link created; the earlier link no longer works."
          : "Invite link created"
      );
      setEmail("");
      refetch();
      refetchInvites();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-6">
      {teams && teams.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Your Teams</CardTitle>
            <CardDescription>Switch the team you are working in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {teams.map((team) => (
              <div
                key={team.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{team.name}</span>
                  <Badge variant="secondary">{team.role}</Badge>
                </div>
                {team.id === teamId ? (
                  <Badge variant="outline">Current</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleSwitch(team.id)}
                    disabled={switchingTo !== null}
                    aria-label={`Switch to ${team.name}`}
                  >
                    {switchingTo === team.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowRightLeft className="mr-2 h-4 w-4" />
                    )}
                    Switch
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {currentTeam && (
        <Card>
          <CardHeader>
            <CardTitle>{currentTeam.name}</CardTitle>
          </CardHeader>
        </Card>
      )}

      {canInvite && (
        <Card>
          <CardHeader>
            <CardTitle>Invite Member</CardTitle>
            <CardDescription>Send an invitation to add someone to your team.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="email"
                placeholder="colleague@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1"
                disabled={inviting}
              />
              <Select value={role} onValueChange={setRole} disabled={inviting}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={handleInvite} disabled={inviting || !email.trim()}>
                {inviting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <UserPlus className="mr-2 h-4 w-4" />
                )}
                {inviting ? "Creating..." : "Invite"}
              </Button>
            </div>
            {sharedInvite && (
              <div className="mt-4 space-y-2 rounded-md border bg-muted/40 p-3">
                <p className="text-sm">
                  Share this link with <span className="font-medium">{sharedInvite.email}</span>. It
                  works once and expires in 7 days.
                </p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={sharedInvite.url}
                    aria-label="Invite link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" onClick={() => copyInviteUrl(sharedInvite.url)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : !members?.length ? (
            <EmptyState
              icon={Users}
              title="No team members"
              description="Invite your first team member to collaborate."
              illustration={<EmptyTeamSvg />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.user_id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="bg-primary/10 text-xs text-primary">
                            {getInitials(m.display_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{m.display_name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.email}</TableCell>
                    <TableCell>
                      <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(m.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {canRemove(m.role, m.user_id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={
                            m.user_id === user?.id ? "Leave team" : `Remove ${m.display_name}`
                          }
                          onClick={() => handleRemove(m.user_id, m.display_name || m.email)}
                        >
                          <UserMinus className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Pending Invites</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created</TableHead>
                  {canInvite && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell>{invite.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{invite.role}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(invite.created_at).toLocaleDateString()}
                    </TableCell>
                    {canInvite && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Revoke invite for ${invite.email}`}
                          onClick={() => handleRevokeInvite(invite.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
