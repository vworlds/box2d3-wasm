#!/usr/bin/env awk -f

# Flag to track if we made the replacement
BEGIN { found = 0 }

# Look for the target line and replace it
/^export default function MainModuleFactory/ {
  found = 1
  while ((getline line < template) > 0) {
    print line
  }
  close(template)
  next
}

# Print all other lines unchanged
{ print }

# Set exit code if no replacement was made
END { exit !found }