-- Policy Code Extractor Database Schema
-- Run this script to create the necessary tables

-- Create policies table
CREATE TABLE IF NOT EXISTS policies (
    id UUID PRIMARY KEY,
    article_id VARCHAR(20) NOT NULL,
    title VARCHAR(500) NOT NULL,
    effective_date DATE NOT NULL,
    codes_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    extraction_method VARCHAR(20),
    confidence INTEGER,
    error_message TEXT,
    s3_key VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create ICD-10 codes table
CREATE TABLE IF NOT EXISTS icd10_codes (
    id UUID PRIMARY KEY,
    code VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(100) NOT NULL,
    policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_policies_article_id ON policies(article_id);
CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);
CREATE INDEX IF NOT EXISTS idx_policies_created_at ON policies(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_icd10_codes_policy_id ON icd10_codes(policy_id);
CREATE INDEX IF NOT EXISTS idx_icd10_codes_code ON icd10_codes(code);
CREATE INDEX IF NOT EXISTS idx_icd10_codes_category ON icd10_codes(category);

-- Full text search index for descriptions
CREATE INDEX IF NOT EXISTS idx_icd10_codes_description_search 
ON icd10_codes USING gin(to_tsvector('english', description));

-- Add comments
COMMENT ON TABLE policies IS 'CMS policy documents that have been processed';
COMMENT ON TABLE icd10_codes IS 'ICD-10 codes extracted from policy documents';
COMMENT ON COLUMN policies.article_id IS 'CMS Article ID (e.g., A52464)';
COMMENT ON COLUMN policies.status IS 'pending, processing, completed, failed';
COMMENT ON COLUMN policies.extraction_method IS 'regex, llm, or hybrid';
COMMENT ON COLUMN policies.confidence IS 'Extraction confidence score (0-100)';
COMMENT ON COLUMN policies.s3_key IS 'S3 object key for stored PDF';
COMMENT ON COLUMN icd10_codes.code IS 'ICD-10-CM code (e.g., E10.9)';
COMMENT ON COLUMN icd10_codes.category IS 'Diabetes category description';
