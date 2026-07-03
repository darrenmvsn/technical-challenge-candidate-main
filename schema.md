# ACORD Form Fields

These are the fillable field names from the two ACORD form PDFs. Each field has a name and can be filled via `fill_field(field_name, value)`.

## ACORD 125 — Commercial Insurance Application

### Producer / Broker Information
- producer_name
- producer_address
- producer_contact_name
- producer_phone
- producer_email

### Policy Information
- effective_date
- expiration_date

### Applicant Information
- policyholder_first_name
- policyholder_last_name
- dba_name
- mailing_address
  - street
  - city
  - state
  - zip
- business_phone
- policyholder_email
- website_url
- entity_type
- state_of_incorporation
- fein
- sic_code
- annual_gross_revenue
- employee_count_full_time
- employee_count_part_time

### Status of Transaction
- application_date
- is_quote
- is_new_coverage

### Contact Information
- contact_first_name
- contact_last_name
- contact_email
- contact_phone

### Premises Information
- locations
  - loc_number
  - bld_number
  - address
    - street
    - city
    - state
    - zip
  - county

### Nature of Business
- nature_of_business
- date_business_started
- naics_code
- contractor_license_number
- contractor_license_state
- business_description

### General Information
- is_subsidiary
- has_subsidiaries
- has_safety_manual
- has_safety_position
- has_monthly_safety_meetings
- has_osha
- has_flammable_exposure
- has_other_insurance_same_carrier
- has_abuse_discrimination_claims
- has_fraud_bribery_arson_conviction
- has_safety_violations
- has_foreclosure
- has_judgement_lien_last_5_years
- has_other_business_ventures
- has_foreign_operations

### Prior Carrier Information
- prior_carriers
  - carrier_name
  - policy_number
  - effective_date
  - expiration_date
  - annual_premium
- has_coverage_declined

### Loss History
- has_claims_last_5_years
- claims
  - year
  - type
  - amount
  - description

### Remarks
- remarks

---

## ACORD 126 — Commercial General Liability Section

### Coverages
- gl_claims_made_or_occurrence
- gl_retroactive_date
- entry_date_claims_made

### Limits
- limit_applies_per
- gl_each_occurrence_limit
- gl_general_aggregate_limit
- gl_products_completed_ops_aggregate
- gl_personal_advertising_injury_limit
- gl_damage_to_rented_premises
- gl_medical_expense_limit
- gl_employee_benefits_limit

### Deductibles
- gl_deductible_property_damage
- gl_deductible_bodily_injury
- gl_deductible_per_claim_or_occurrence

### Schedule of Hazards
- hazard_classifications
  - loc_number
  - haz_number
  - classification
  - class_code
  - premium_basis
  - exposure
  - territory
  - prem_ops_rate
  - prem_ops_premium

### Contractor Operations
- subcontractor_work_percentage
- subcontractor_costs
- employee_count_full_time
- employee_count_part_time
- subcontracted_work_description
- contractor_underground_work

### Products / Completed Operations
- products_schedule
  - product_name
  - annual_gross_sales
  - number_of_units
  - intended_use
- does_applicant_install_service_products
- has_guarantees_warranties
- products_recalled_discontinued

### Additional Interests
- additional_insured_required
- additional_insureds
  - name
  - address
  - relationship
- waiver_of_subrogation_required
- primary_noncontributory_required
- per_project_aggregate

### Premises
- gl_premises
  - loc_number
  - address
    - street
    - city
    - state
    - zip
  - occupancy
  - is_owned_or_leased

### General Information
- has_medical_professionals
- hazardous_materials_used
- operations_sold_acquired_discontinued
- owns_watercraft_docks
- premises_parking_lot_owned
- recreation_facilities_provided
- has_structural_alterations
- has_demolition_exposure
- active_in_joint_ventures
- has_labor_interchange
- has_written_safety_program
