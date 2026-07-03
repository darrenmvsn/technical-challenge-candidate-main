2 function calls
function can take in the type of form

before pdf creation gets called, human needs to review it.

there could be an interface where humans would review the structured output.

fillform will generate pdfs and return bytes and put it in a storage (blob maybe)

transcript.json -> trigger webhook -> processing function hosted serverless (has access to LLM vertex/bedrock)

its like a BQ table
associated with a client, insurance broker owner, pdf_form_type (125 or 126), id, Structured output JSON_125, JSON Column transcript, approved, pdf_created, updated_at

{
    "policyholder_first_name": "",
    "policyholder_last_name": "",
    "dba_name": "",
    "mailing_address" : {
        "street": "",
        "city": "",
        ...
    },
    "annual_gross_revenue": ""
}

basically we get this transcripts.json from the webhook and using that we have a processing function which will look at 
the json and do the above. in regards to the structured output, we can use "structured output" or something from pydantic AI as well so the types are correct and valid. and then we need to design the solution such that we consider things like this:
say for our pdf schemas, there are some attributes in there that are the same. whats the smartest and most efficient way to have them stored so that we dont violate DRY... 