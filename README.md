# Calorie Tracker Telegram Bot

A Telegram bot to help you effortlessly track your daily calorie intake. Built using grammY and hosted on Supabase Edge Functions.

## Architecture

- **Supabase Edge Functions:** Serverless hosting for the bot execution logic.
- **Supabase Database:** Keeps track of users, logged meals, and daily caloric goals.

## Features

- Log daily meals and automatically track calories.
- View daily/weekly calorie summaries.
- Interactive user interface directly within Telegram.

## Setup & Deployment

Deployed on Supabase Edge Functions. Ensure the bot token is added to your Supabase Secrets and the webhook is registered to the function URL.
