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
  interests: string[];
  city: string | null;
  area: string | null;
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
  mediaUrls: string[];
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

export interface Notification {
  id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  author: PublicUser;
}

export interface ExpenseParticipant {
  userId: string;
  handle: string;
  displayName: string;
  allocationMinor: number;
  status: string;
}

export interface PaymentReport {
  id: string;
  participantId: string;
  amountMinor: number;
  status: string;
  verificationSource: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

export interface ExpenseDetail {
  expense: {
    id: string;
    circleId: string;
    creatorId: string;
    payerId: string;
    amountMinor: number;
    currency: string;
    description: string;
    splitMode: string;
    dueDate: string | null;
    receiptUrl: string | null;
    status: string;
    createdAt: string;
  };
  participants: ExpenseParticipant[];
  paymentReports: PaymentReport[];
}

export interface ExpenseEvent {
  id: string;
  actor_id: string | null;
  type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface PublicProfile extends PublicUser {
  interests: string[];
  profileAudience: string;
  followerCount: number;
}
