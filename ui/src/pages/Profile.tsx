import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateUserProfile } from "@paperclipai/shared";
import { Shield, Trash2, UserRound } from "lucide-react";
import { authApi } from "@/api/auth";
import { Identity } from "@/components/Identity";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";

export function ProfilePage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Profile" }]);
  }, [setBreadcrumbs]);

  const profileQuery = useQuery({
    queryKey: queryKeys.auth.profile,
    queryFn: () => authApi.getProfile(),
  });

  useEffect(() => {
    if (!profileQuery.data) return;
    setName(profileQuery.data.name);
  }, [profileQuery.data]);

  const updateProfile = useMutation({
    mutationFn: (input: UpdateUserProfile) => authApi.updateProfile(input),
    onSuccess: async (profile) => {
      setName(profile.name);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.profile }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }),
      ]);
    },
  });

  const uploadAvatar = useMutation({
    mutationFn: (file: File) => authApi.uploadAvatar(file),
    onSuccess: async () => {
      setAvatarError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.profile }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }),
      ]);
    },
    onError: (error) => {
      setAvatarError(error instanceof Error ? error.message : "Failed to upload avatar.");
    },
  });

  const removeAvatar = useMutation({
    mutationFn: () => authApi.removeAvatar(),
    onSuccess: async () => {
      setAvatarError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.profile }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }),
      ]);
    },
    onError: (error) => {
      setAvatarError(error instanceof Error ? error.message : "Failed to remove avatar.");
    },
  });

  if (profileQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading profile...</div>;
  }

  if (profileQuery.error || !profileQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {profileQuery.error instanceof Error ? profileQuery.error.message : "Failed to load profile."}
      </div>
    );
  }

  const profile = profileQuery.data;
  const nameDirty = name.trim() !== profile.name;

  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setAvatarError(null);
    uploadAvatar.mutate(file);
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Update how your user identity appears across the board UI.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="text-sm font-semibold">Preview</div>
            <div className="rounded-lg border border-border/70 bg-background px-4 py-4">
              <Identity
                name={name.trim() || profile.name}
                avatarUrl={profile.image}
                detail={profile.email}
                size="lg"
                stacked
              />
            </div>
            {profile.isInstanceAdmin ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-accent/40 px-3 py-1 text-xs text-muted-foreground">
                <Shield className="h-3.5 w-3.5" />
                Instance admin
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="profile-name">
                Display name
              </label>
              <input
                id="profile-name"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
              />
            </div>

            <div className="space-y-1">
              <div className="text-sm font-medium">Email</div>
              <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                {profile.email}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Avatar</div>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarChange}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
              />
              <div className="flex flex-wrap gap-2">
                {profile.image ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={removeAvatar.isPending}
                    onClick={() => removeAvatar.mutate()}
                  >
                    <Trash2 className="size-4" />
                    {removeAvatar.isPending ? "Removing..." : "Remove avatar"}
                  </Button>
                ) : null}
              </div>
              {uploadAvatar.isPending ? (
                <p className="text-sm text-muted-foreground">Uploading avatar...</p>
              ) : null}
              {avatarError ? <p className="text-sm text-destructive">{avatarError}</p> : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                disabled={!name.trim() || !nameDirty || updateProfile.isPending}
                onClick={() => updateProfile.mutate({ name: name.trim() })}
              >
                {updateProfile.isPending ? "Saving..." : "Save changes"}
              </Button>
              {updateProfile.isError ? (
                <span className="text-sm text-destructive">
                  {updateProfile.error instanceof Error ? updateProfile.error.message : "Failed to save profile."}
                </span>
              ) : null}
              {updateProfile.isSuccess && !nameDirty ? (
                <span className="text-sm text-muted-foreground">Saved</span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
