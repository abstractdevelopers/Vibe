export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
}

export interface Me extends PublicUser {
  email: string;
  isAdmin: boolean;
  privacy: {
    discoverable: boolean;
    profileAudience: "public" | "connections" | "private";
    activityVisibility: "public" | "connections" | "private";
    readReceipts: boolean;
    locationEnabled: boolean;
    contactsSyncEnabled: boolean;
  };
}

export interface PollOption {
  id: string;
  label: string;
  votes: number;
}

export interface PollActivity {
  id: string;
  state: string;
  endsAt: string | null;
  options: PollOption[];
  totalVotes: number;
  viewerOptionId: string | null;
}

export interface FeedItem {
  id: string;
  type: string;
  audience: string;
  circleId: string | null;
  body: string | null;
  isSponsored: boolean;
  createdAt: string;
  author: PublicUser;
  reactionCount: number;
  commentCount: number;
  viewerReacted: boolean;
  activity: PollActivity | null;
}

export interface CircleSummary {
  id: string;
  name: string;
  description: string | null;
  privacy: string;
  role: string;
  member_count: number;
}

export interface ExpenseSummary {
  id: string;
  description: string;
  amountMinor: number;
  currency: string;
  splitMode: string;
  status: string;
  payerId: string;
  createdAt: string;
}

export interface PlanSummary {
  id: string;
  title: string;
  state: string;
  starts_at: string;
  timezone: string;
  place: string | null;
}
