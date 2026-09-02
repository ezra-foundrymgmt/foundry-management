/**
 * Narrow, conservative database boundary used until the live project's generated
 * Supabase types can replace it. Values are unknown by design and are validated
 * at each application boundary instead of flowing through as `any`.
 */
type GenericTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
};

type GenericFunction = {
  Args: Record<string, unknown>;
  Returns: unknown;
};

export interface Database {
  public: {
    Tables: Record<string, GenericTable>;
    Views: Record<string, never>;
    Functions: Record<string, GenericFunction>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, never>;
  };
}
