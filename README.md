# JobMate REST API

REST API Backend for JobMate — built with Express.js to handle core functionalities such as user authentication, account management, job posting endpoints, and CV/profile data handling. This service also acts as a gateway for communicating with the ML inference API, designed to support a scalable and accessible job recommendation platform.

## 🌐 Deployment

**API Base URL:** https://jobseeker-capstone-705829099986.asia-southeast2.run.app

## 📖 API Documentation

**Postman Documentation:** https://documenter.getpostman.com/view/36349178/2sB2qfAJyP

## 📋 Overview

JobMate is a comprehensive platform designed to connect job seekers with companies. This API provides a complete suite of endpoints to manage all aspects of the job-seeking and recruitment process, including company profiles, job postings, user profiles, applications, and more.

## 🔐 Authentication

To access protected endpoints, you need to obtain a bearer token first.

### Endpoint
- `POST /getBearerToken` - Authenticates the user and returns a bearer token for authorization

**Usage:** Include the bearer token in the Authorization header as `Bearer <token>` for subsequent requests.


## 👤 User Profile & Portfolio Management

### Profile Management
- `GET /getProfile` - Retrieves the user's main profile information
- `PATCH /editProfile` - Updates the user's profile details

### Education Management
- `POST /addEducation` - Adds a new education entry to the user's profile
- `GET /getEducation` - Retrieves the user's education history
- `PATCH /editEducation` - Modifies an existing education entry
- `DELETE /deleteEducation` - Removes an education entry

### Experience Management
- `POST /addExperience` - Adds a new work experience entry
- `GET /getExperience` - Retrieves the user's work experience
- `PATCH /editExperience` - Modifies a work experience entry
- `DELETE /deleteExperience` - Removes a work experience entry

### Skills Management
- `POST /addHardSkills` - Adds hard skills to the user's profile
- `POST /addSoftSkills` - Adds soft skills to the user's profile
- `GET /getHardSkills` - Retrieves the user's hard skills
- `GET /getSoftSkills` - Retrieves the user's soft skills
- `DELETE /deleteHardSkills` - Removes hard skills from the user's profile
- `DELETE /deleteSoftSkills` - Removes soft skills from the user's profile

### Portfolio Management
- `POST /addPortofolio` - Adds a new portfolio item
- `PATCH /PatchPortofolio` - Updates an existing portfolio item
- `GET /getPortofolio` - Retrieves the user's portfolio
- `DELETE /deletePortofolio` - Deletes a portfolio item

## 📄 Documents & Preferences

### Preferences Management
- `POST /addPreferences` - Sets the user's job-seeking preferences
- `GET /getPreferences` - Retrieves the user's preferences
- `PATCH /editPreferences` - Updates the user's job preferences

### Document Management
- `POST /addDocument` - Adds a new document
- `GET /getUploadDocument` - Retrieves a list of uploaded documents
- `PATCH /editDocument` - Modifies an existing document's details
- `DELETE /deleteDocument` - Removes a document
- `GET /getResume` - Fetches the user's resume

## 📝 Application & Bookmarks

### Bookmark Management
- `POST /addBookmark` - Saves a job to the user's bookmarks
- `GET /getBookmark` - Retrieves the user's bookmarked jobs
- `DELETE /deleteBookmark` - Removes a bookmark
- `DELETE /deleteBookmarkJobId` - Removes a bookmark by job ID

### Application Management
- `POST /addLamaran` - Submits a new job application
- `GET /getLamaran` - Retrieves the user's submitted applications
- `GET /getLamaranDetail` - Gets the details of a specific application
- `DELETE /deleteLamaran` - Deletes a job application

## 🛠️ Technology Stack

- **Framework:** Express.js
- **Runtime:** Node.js
- **Deployment:** Google Cloud Run
- **Documentation:** Postman

## 🚀 Getting Started

1. **Base URL:** Use the deployed API at `https://jobseeker-capstone-705829099986.asia-southeast2.run.app`
2. **Authentication:** Obtain a bearer token using the `/getBearerToken` endpoint
3. **API Documentation:** Refer to the [Postman documentation](https://documenter.getpostman.com/view/36349178/2sB2qfAJyP) for detailed endpoint specifications
4. **Authorization:** Include the bearer token in your request headers for protected endpoints


