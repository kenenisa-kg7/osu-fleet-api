export type TripRequest = {
  purpose: string;
  origin: string;
  destination: string;
  pickupTime: string;
  passengers: number;
  requestedBy: string;
  department: string;
};

export type StoredTripRequest = TripRequest & {
  id: string;
  status: string;
  createdAt: string;
};