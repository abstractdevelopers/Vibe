/**
 * Icon layer.
 *
 * Backed by Lucide — a professionally drawn, optically consistent set (24px
 * grid, 2px stroke, matched terminals) rather than hand-rolled paths. We wrap
 * it here so the rest of the app imports from one place and so the shared
 * defaults (size, stroke weight, accessibility) stay consistent everywhere.
 *
 * Icons are decorative by default; interactive controls carry their own
 * accessible name.
 */
import type { LucideIcon, LucideProps } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  BarChart3,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDollarSign,
  Clock,
  Compass,
  Globe,
  HandCoins,
  Image,
  Camera,
  Heart,
  Home,
  Inbox,
  Info,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  MapPin,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Moon,
  Plus,
  Receipt,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Store,
  Timer,
  TrendingUp,
  Trophy,
  Trash2,
  Upload,
  User,
  Pencil,
  Ticket,
  Flame,
  Gift,
  Navigation,
  Download,
  UserCheck,
  Users,
  Vote,
  Wallet,
  X,
} from "lucide-react";

/** Sensible optical defaults; callers override size/stroke when needed. */
function icon(Base: LucideIcon) {
  return function Icon({ strokeWidth = 1.9, ...props }: LucideProps) {
    return <Base strokeWidth={strokeWidth} aria-hidden="true" {...props} />;
  };
}

export const HomeIcon = icon(Home);
export const CirclesIcon = icon(Users);
export const CompassIcon = icon(Compass);
export const UserIcon = icon(User);
export const PlusIcon = icon(Plus);
export const InboxIcon = icon(Inbox);
export const HeartIcon = icon(Heart);
export const ChatIcon = icon(MessageCircle);
export const CommentIcon = icon(MessageSquare);
export const ShareIcon = icon(Share2);
export const CalendarIcon = icon(CalendarDays);
export const PollIcon = icon(Vote);
export const PlanIcon = icon(ListChecks);
export const SplitIcon = icon(HandCoins);
export const ShieldIcon = icon(ShieldCheck);
export const WalletIcon = icon(Wallet);
export const MoneyIcon = icon(CircleDollarSign);
export const ReceiptIcon = icon(Receipt);
export const CheckIcon = icon(Check);
export const CircleCheckIcon = icon(CircleCheck);
export const ArrowLeftIcon = icon(ArrowLeft);
export const ArrowRightIcon = icon(ArrowRight);
export const CloseIcon = icon(X);
export const LockIcon = icon(Lock);
export const GlobeIcon = icon(Globe);
export const UsersIcon = icon(Users);
export const MapPinIcon = icon(MapPin);
export const MoonIcon = icon(Moon);
export const LogOutIcon = icon(LogOut);
export const ChevronRightIcon = icon(ChevronRight);
export const SendIcon = icon(Send);
export const SettingsIcon = icon(Settings);
export const SearchIcon = icon(Search);
export const BellIcon = icon(Bell);
export const ClockIcon = icon(Clock);
export const TimerIcon = icon(Timer);
export const TrendingIcon = icon(TrendingUp);
export const TrophyIcon = icon(Trophy);
export const MegaphoneIcon = icon(Megaphone);
export const StoreIcon = icon(Store);
export const BarChartIcon = icon(BarChart3);
export const InfoIcon = icon(Info);
export const AtIcon = icon(AtSign);
export const UserCheckIcon = icon(UserCheck);
export const SpinnerIcon = icon(Loader2);
export const ImageIcon = icon(Image);
export const CameraIcon = icon(Camera);
export const UploadIcon = icon(Upload);
export const EditIcon = icon(Pencil);
export const TicketIcon = icon(Ticket);
export const TrendingFlameIcon = icon(Flame);
export const NearbyIcon = icon(Navigation);
export const TrashIcon = icon(Trash2);
export const GiftIcon = icon(Gift);
export const DownloadIcon = icon(Download);

