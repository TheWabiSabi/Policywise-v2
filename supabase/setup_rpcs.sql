CREATE OR REPLACE FUNCTION check_username(username_to_check text)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles WHERE username = username_to_check
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION check_email(email_to_check text)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles WHERE email = email_to_check
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_email_by_username(lookup_username text)
RETURNS text AS $$
DECLARE
  found_email text;
BEGIN
  SELECT email INTO found_email FROM profiles WHERE username = lookup_username LIMIT 1;
  RETURN found_email;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
