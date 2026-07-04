import type { FormType } from '../schema/profile'

export interface StaticBinding { form_field_path: string; profile_field_path: string }

/** Scalar / fixed-object bindings. Same profile_field_path in two forms == shared field. */
export const STATIC_BINDINGS: Record<FormType, StaticBinding[]> = {
  acord_125: [
    { form_field_path: 'policyholder_first_name', profile_field_path: 'policyholder_first_name' },
    { form_field_path: 'policyholder_last_name', profile_field_path: 'policyholder_last_name' },
    { form_field_path: 'dba_name', profile_field_path: 'dba_name' },
    { form_field_path: 'entity_type', profile_field_path: 'entity_type' },
    { form_field_path: 'fein', profile_field_path: 'fein' },
    { form_field_path: 'annual_gross_revenue', profile_field_path: 'annual_gross_revenue' },
    { form_field_path: 'employee_count_full_time', profile_field_path: 'employee_count_full_time' },
    { form_field_path: 'employee_count_part_time', profile_field_path: 'employee_count_part_time' },
    { form_field_path: 'mailing_address.street', profile_field_path: 'mailing_address.street' },
    { form_field_path: 'mailing_address.city', profile_field_path: 'mailing_address.city' },
    { form_field_path: 'mailing_address.state', profile_field_path: 'mailing_address.state' },
    { form_field_path: 'mailing_address.zip', profile_field_path: 'mailing_address.zip' },
  ],
  acord_126: [
    // shared fields point at the SAME profile paths -> DRY
    { form_field_path: 'employee_count_full_time', profile_field_path: 'employee_count_full_time' },
    { form_field_path: 'employee_count_part_time', profile_field_path: 'employee_count_part_time' },
  ],
}

/** Collections a form expands positionally: form-array prefix -> profile collection name. */
export const COLLECTION_BINDINGS: Record<FormType, { form_prefix: string; collection: string; fields: string[] }[]> = {
  acord_125: [{ form_prefix: 'claims', collection: 'claims', fields: ['year', 'type', 'amount', 'description'] }],
  acord_126: [],
}
